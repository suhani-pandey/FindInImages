import * as pdfjsLib from "../lib/pdfjs/pdf.min.mjs";
import { injectPDFTextLayer, appendOCRTextLayer, filterOverlappingWords } from "./text-layer.js";
import { getCachedPage, setCachedPage, clearCache } from "./cache.js";
import { postProcessWords } from "./ocr-postprocess.js";

// Operator codes that indicate the page paints a raster image (may contain text)
const IMAGE_OPS = new Set([
  pdfjsLib.OPS.paintImageXObject,
  pdfjsLib.OPS.paintInlineImageXObject,
  pdfjsLib.OPS.paintImageMaskXObject,
  pdfjsLib.OPS.paintImageXObjectRepeat,
]);

// ── PDF.js worker ────────────────────────────────────────────────────────────
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("lib/pdfjs/pdf.worker.min.mjs");

// ── Tesseract paths (window.Tesseract is loaded via <script> in viewer.html) ─
const TESSERACT_WORKER_PATH = chrome.runtime.getURL("lib/tesseract/worker.min.js");
const TESSERACT_CORE_PATH   = chrome.runtime.getURL("lib/tesseract/");
// Bundled eng.traineddata.gz lives here — fully offline, no CDN fetch
const TESSERACT_LANG_PATH   = chrome.runtime.getURL("lib/tesseract/lang");

const status     = document.getElementById("status");
const container  = document.getElementById("viewer-container");
const reprocessBtn = document.getElementById("reprocess");
const langSelect = document.getElementById("lang-select");

// ── OCR language selection ───────────────────────────────────────────────────
// Persisted in localStorage. Default to English. Allowed values match the
// bundled traineddata files and the <option>s in viewer.html.
const ALLOWED_LANGS = new Set(["eng", "dan", "eng+dan"]);
const STORED_LANG = localStorage.getItem("fii_ocr_lang");
const OCR_LANG = ALLOWED_LANGS.has(STORED_LANG) ? STORED_LANG : "eng";

langSelect.value = OCR_LANG;
langSelect.addEventListener("change", () => {
  localStorage.setItem("fii_ocr_lang", langSelect.value);
  // OCR results are cached per-language, so just reload to reprocess with the
  // new language (cache hits make previously-seen languages instant).
  location.reload();
});

// Clear cache button — wipe all cached OCR and reload to reprocess from scratch
reprocessBtn.addEventListener("click", async () => {
  reprocessBtn.disabled = true;
  reprocessBtn.textContent = "Clearing…";
  try {
    await clearCache();
  } catch (err) {
    console.warn("[FindInImages] clearCache failed:", err);
  }
  location.reload();
});

// ── Resolve PDF URL ──────────────────────────────────────────────────────────
// URLSearchParams.get() already percent-decodes the value, which gives us
// a string with literal spaces — valid for display but not for fetch().
// encodeURI re-encodes spaces/special chars while leaving :// / ? & intact.
const params = new URLSearchParams(window.location.search);
const rawUrl  = params.get("url") || params.get("file");
const pdfUrl  = rawUrl ? encodeURI(rawUrl) : null;

// Cache is scoped per document AND per OCR language, so switching languages
// reprocesses (and remembers) each language independently.
const cacheDocId = `${pdfUrl}::${OCR_LANG}`;

if (!pdfUrl) {
  status.textContent = "No PDF loaded. Open a .pdf link in Chrome to use this viewer.";
} else {
  loadPDF(pdfUrl);
}

// ── Main loader (lazy) ───────────────────────────────────────────────────────
// Instead of rendering+OCR'ing every page upfront (which blocks on large PDFs),
// we create correctly-sized placeholders immediately and only render/OCR each
// page as it scrolls near the viewport.
let pdfDoc = null;
const renderedPages = new Set();
let pageObserver = null;

async function loadPDF(url) {
  status.textContent = "Loading PDF…";

  try {
    pdfDoc = await pdfjsLib.getDocument({ url }).promise;
  } catch (err) {
    const isFileUrl = url.startsWith("file://");
    status.textContent = isFileUrl
      ? `Cannot load local file. In chrome://extensions → Find in Images → enable "Allow access to file URLs", then reload.`
      : `Failed to load PDF: ${err.message}`;
    console.error("[FindInImages] PDF load error:", err);
    return;
  }

  const total = pdfDoc.numPages;

  // Estimate placeholder size from page 1 so the scrollbar reserves the right
  // space. Each page's exact size is applied when it actually renders.
  const firstPage = await pdfDoc.getPage(1);
  const estVp = firstPage.getViewport({ scale: pageScaleFor(firstPage) });

  // Render pages a little before they enter view for a smoother scroll.
  pageObserver = new IntersectionObserver(onPageVisible, {
    root: null,
    rootMargin: "300px 0px",
    threshold: 0.01,
  });

  for (let pageNum = 1; pageNum <= total; pageNum++) {
    const wrapper = document.createElement("div");
    wrapper.className = "page-wrapper";
    wrapper.style.width  = `${estVp.width}px`;
    wrapper.style.height = `${estVp.height}px`;
    wrapper.dataset.pageNum = String(pageNum);
    container.appendChild(wrapper);
    pageObserver.observe(wrapper);
  }

  status.textContent = `${total} page${total > 1 ? "s" : ""} — loading…`;

  // Native Ctrl+F can only find text that's in the DOM, so lazy-rendering alone
  // would make off-screen pages unsearchable. This background pass processes the
  // remaining pages progressively during idle time — visible pages still render
  // first (observer + renderedPages guard), and scrolling is never blocked.
  startBackgroundIndexing(total);
}

// Process every page in the background so Ctrl+F covers the whole document.
// Uses requestIdleCallback so it yields to scrolling and on-demand renders.
function startBackgroundIndexing(total) {
  const idle = (fn) =>
    window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 1500 }) : setTimeout(fn, 60);

  let next = 1;
  const step = async () => {
    while (next <= total && renderedPages.has(next)) next++;
    if (next > total) {
      status.textContent = `All ${total} page${total > 1 ? "s" : ""} ready — Ctrl+F to search`;
      return;
    }
    const pageNum = next++;
    const wrapper = container.querySelector(`.page-wrapper[data-page-num="${pageNum}"]`);
    if (wrapper) {
      try {
        await renderPage(pageNum, wrapper);
      } catch (err) {
        console.error(`[FindInImages] background index error on page ${pageNum}:`, err);
      }
    }
    idle(step);
  };

  idle(step);
}

// Fit-to-width scale for a page (capped so small pages don't blow up)
function pageScaleFor(page) {
  const containerWidth = container.clientWidth - 40; // account for padding
  const natural = page.getViewport({ scale: 1.0 });
  return containerWidth > 0 ? Math.min(2.0, containerWidth / natural.width) : 1.5;
}

// Render pages as their placeholders approach the viewport
function onPageVisible(entries) {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const wrapper = entry.target;
    pageObserver.unobserve(wrapper); // one-shot per page
    const pageNum = Number(wrapper.dataset.pageNum);
    renderPage(pageNum, wrapper).catch((err) =>
      console.error(`[FindInImages] render failed on page ${pageNum}:`, err)
    );
  }
}

// ── Page renderer (called lazily by the observer) ────────────────────────────
async function renderPage(pageNum, wrapper) {
  if (renderedPages.has(pageNum)) return;
  renderedPages.add(pageNum);

  const page = await pdfDoc.getPage(pageNum);
  const viewport = page.getViewport({ scale: pageScaleFor(page) });

  // Correct the placeholder to the page's real dimensions
  wrapper.style.width  = `${viewport.width}px`;
  wrapper.style.height = `${viewport.height}px`;

  const canvas = document.createElement("canvas");
  canvas.width  = viewport.width;
  canvas.height = viewport.height;

  const textLayerDiv = document.createElement("div");
  textLayerDiv.className = "text-layer";
  textLayerDiv.style.height = `${viewport.height}px`;

  wrapper.appendChild(canvas);
  wrapper.appendChild(textLayerDiv);

  await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;

  await processTextLayer(page, canvas, textLayerDiv, viewport, pageNum, pdfDoc.numPages)
    .catch((err) => console.error(`[FindInImages] Text layer failed on page ${pageNum}:`, err));
}

// ── Text detection → PDF text layer AND/OR OCR ───────────────────────────────
// A page can have native PDF text, images-with-text, or both. We always inject
// the native text, then OCR any images and merge in the non-duplicate words.
async function processTextLayer(page, canvas, textLayerDiv, viewport, pageNum, total) {
  let textContent;
  try {
    textContent = await page.getTextContent();
  } catch {
    textContent = { items: [] };
  }

  // 1. Inject native PDF text (accurate, fast). Returns boxes for dedup.
  const pdfBoxes = injectPDFTextLayer(textLayerDiv, textContent, viewport);

  // 2. Does the page paint any images that might contain text?
  const hasImages = await pageHasImages(page);

  console.log(
    `[FindInImages] Page ${pageNum}: ${pdfBoxes.length} PDF text items, hasImages=${hasImages}`
  );

  // 3. Pure text page with no images — nothing more to do.
  if (!hasImages) {
    updateStatus(pageNum, total, pdfBoxes.length > 0 ? "text" : "ocr-empty");
    return;
  }

  // 4. Page has images. Reuse cached OCR if available, else run OCR and store it.
  //    Cached words are normalized (0..1); denormalize to the current canvas.
  let normWords = await getCachedPage(cacheDocId, pageNum);

  if (normWords) {
    console.log(`[FindInImages] Page ${pageNum}: cache hit (${normWords.length} words)`);
  } else {
    updateStatus(pageNum, total, "ocr-start");
    const rawWords = await runOCR(canvas, pageNum); // absolute canvas-pixel coords
    if (!rawWords) {
      updateStatus(pageNum, total, pdfBoxes.length > 0 ? "text" : "ocr-empty");
      return;
    }
    // Clean up OCR output and add correction variants before caching
    const words = postProcessWords(rawWords);
    normWords = normalizeWords(words, canvas.width, canvas.height);
    await setCachedPage(cacheDocId, pageNum, normWords);
    console.log(
      `[FindInImages] Page ${pageNum}: OCR ${rawWords.length} raw → ${words.length} after post-processing (cached)`
    );
  }

  // Denormalize to current canvas, drop true duplicates of native text, inject.
  const absWords = denormalizeWords(normWords, canvas.width, canvas.height);
  const newWords = filterOverlappingWords(absWords, pdfBoxes);
  appendOCRTextLayer(textLayerDiv, newWords);

  updateStatus(pageNum, total, newWords.length > 0 ? "ocr-done" : (pdfBoxes.length > 0 ? "text" : "ocr-empty"));
}

// ── Coordinate normalization (for scale-independent caching) ─────────────────
function normalizeWords(words, w, h) {
  return words.map((word) => ({
    text: word.text,
    bbox: { x0: word.bbox.x0 / w, y0: word.bbox.y0 / h, x1: word.bbox.x1 / w, y1: word.bbox.y1 / h },
  }));
}

function denormalizeWords(words, w, h) {
  return words.map((word) => ({
    text: word.text,
    bbox: { x0: word.bbox.x0 * w, y0: word.bbox.y0 * h, x1: word.bbox.x1 * w, y1: word.bbox.y1 * h },
  }));
}

// ── Image detection via operator list ────────────────────────────────────────
async function pageHasImages(page) {
  try {
    const opList = await page.getOperatorList();
    return opList.fnArray.some((fn) => IMAGE_OPS.has(fn));
  } catch (err) {
    console.warn("[FindInImages] getOperatorList failed; assuming images present:", err);
    return true; // fail open — better to OCR unnecessarily than miss text
  }
}

// ── OCR via Tesseract.js (window.Tesseract set by <script> in viewer.html) ───
let _tesseractWorker = null;

async function getOCRWorker() {
  if (_tesseractWorker) return _tesseractWorker;

  if (!window.Tesseract) {
    throw new Error("Tesseract not loaded — check that tesseract.min.js is in lib/tesseract/");
  }

  console.log(`[FindInImages] Initialising Tesseract worker (lang=${OCR_LANG})…`);
  _tesseractWorker = await window.Tesseract.createWorker(OCR_LANG, 1, {
    workerPath: TESSERACT_WORKER_PATH,
    corePath:   TESSERACT_CORE_PATH,
    langPath:   TESSERACT_LANG_PATH, // bundled traineddata — no CDN
    workerBlobURL: false,
    logger: (m) => {
      if (m.status === "recognizing text") {
        status.textContent = `OCR … ${Math.round(m.progress * 100)}%`;
      } else {
        console.log("[FindInImages] Tesseract:", m.status, m.progress ?? "");
      }
    },
  });

  console.log("[FindInImages] Tesseract worker ready");
  return _tesseractWorker;
}

async function runOCR(canvas, pageNum) {
  try {
    const worker = await getOCRWorker();
    console.log(`[FindInImages] Page ${pageNum}: running OCR…`);

    // Tesseract.js v5+ omits detailed results by default — request blocks so we
    // get the block→paragraph→line→word hierarchy with per-word bounding boxes.
    const { data } = await worker.recognize(canvas, {}, { blocks: true });

    return flattenWords(data.blocks);
  } catch (err) {
    console.error(`[FindInImages] OCR error on page ${pageNum}:`, err);
    return null;
  }
}

// Flatten blocks → paragraphs → lines → words into a flat [{text, bbox, confidence}] list
function flattenWords(blocks) {
  const words = [];
  for (const block of blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        for (const w of line.words ?? []) {
          if (w.text && w.bbox) {
            words.push({
              text: w.text,
              confidence: w.confidence,
              bbox: { x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 },
            });
          }
        }
      }
    }
  }
  return words;
}

// ── Status helpers ───────────────────────────────────────────────────────────
function updateStatus(pageNum, total, phase) {
  const p = `(page ${pageNum}/${total})`;
  const msg = {
    "text":      `Text layer ready ${p} — Ctrl+F to search`,
    "ocr-start": `Running OCR ${p}…`,
    "ocr-done":  `OCR complete ${p} — Ctrl+F to search`,
    "ocr-empty": `OCR found no text ${p}`,
  }[phase];
  if (msg) status.textContent = msg;
}
