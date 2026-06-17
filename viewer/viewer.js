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

// ── Custom find bar ──────────────────────────────────────────────────────────
// We override Ctrl/Cmd+F with our own find UI. Native Find makes the invisible
// text-layer visible in a mismatched font (looks like oversized doubled text);
// instead we draw translucent highlight boxes over matches and provide ↑/↓ nav.
const findBar    = document.getElementById("find-bar");
const findInput  = document.getElementById("find-input");
const findCount  = document.getElementById("find-count");
const findPrev   = document.getElementById("find-prev");
const findNext   = document.getElementById("find-next");
const findClose  = document.getElementById("find-close");

let findMatches = []; // [{ boxes: HTMLElement[] }]  in document order
let findActive  = -1;
let findQuery   = "";
let findRefreshTimer = null;

function openFindBar() {
  findBar.hidden = false;
  findInput.focus();
  findInput.select();
  if (findInput.value.trim()) runFind(findInput.value);
}

function closeFindBar() {
  findBar.hidden = true;
  clearFindHighlights();
  findQuery = "";
}

function clearFindHighlights() {
  for (const m of findMatches) for (const b of m.boxes) b.remove();
  findMatches = [];
  findActive = -1;
  findCount.textContent = "0/0";
}

// Build highlight boxes for every occurrence of the query across rendered pages.
// keepIndex/scroll let lazy-load refreshes preserve the user's current match.
function runFind(query, keepIndex = 0, scroll = true) {
  clearFindHighlights();
  findQuery = query.trim().toLowerCase();
  if (!findQuery) return;

  const spans = container.querySelectorAll(".text-layer span");
  for (const span of spans) {
    const node = span.firstChild;
    if (!node || node.nodeType !== Node.TEXT_NODE) continue;

    const text = node.textContent.toLowerCase();
    let from = 0, idx;
    while ((idx = text.indexOf(findQuery, from)) !== -1) {
      const wrapper = span.closest(".page-wrapper");
      if (wrapper) {
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + findQuery.length);

        const wr = wrapper.getBoundingClientRect();
        const boxes = [];
        for (const r of range.getClientRects()) {
          if (r.width <= 0 || r.height <= 0) continue;
          const box = document.createElement("div");
          box.className = "find-highlight";
          box.style.left   = `${r.left - wr.left}px`;
          box.style.top    = `${r.top  - wr.top}px`;
          box.style.width  = `${r.width}px`;
          box.style.height = `${r.height}px`;
          wrapper.appendChild(box);
          boxes.push(box);
        }
        if (boxes.length) findMatches.push({ boxes });
      }
      from = idx + findQuery.length;
    }
  }

  if (findMatches.length) {
    setActiveMatch(Math.min(Math.max(keepIndex, 0), findMatches.length - 1), scroll);
  } else {
    findCount.textContent = "0/0";
  }
}

function setActiveMatch(i, scroll = true) {
  if (!findMatches.length) return;
  if (findActive >= 0 && findMatches[findActive]) {
    for (const b of findMatches[findActive].boxes) b.classList.remove("active");
  }
  findActive = (i + findMatches.length) % findMatches.length;
  const m = findMatches[findActive];
  for (const b of m.boxes) b.classList.add("active");
  if (scroll) m.boxes[0].scrollIntoView({ block: "center", behavior: "smooth" });
  findCount.textContent = `${findActive + 1}/${findMatches.length}`;
}

// Re-run the active search after a page lazily finishes indexing. New pages are
// later in the DOM, so existing match indices stay stable — we keep the active
// match and don't scroll. Debounced to coalesce bursts of page completions.
function scheduleFindRefresh() {
  if (findBar.hidden || !findQuery) return;
  clearTimeout(findRefreshTimer);
  findRefreshTimer = setTimeout(() => runFind(findInput.value, findActive, false), 250);
}

findInput.addEventListener("input", () => runFind(findInput.value));
findNext.addEventListener("click", () => setActiveMatch(findActive + 1));
findPrev.addEventListener("click", () => setActiveMatch(findActive - 1));
findClose.addEventListener("click", closeFindBar);

// Clicking a nav button shouldn't steal focus from the input (keeps typing/keys working)
findNext.addEventListener("mousedown", (e) => e.preventDefault());
findPrev.addEventListener("mousedown", (e) => e.preventDefault());

window.addEventListener("keydown", (e) => {
  // Ctrl/Cmd+F opens the find bar from anywhere
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
    e.preventDefault();
    openFindBar();
    return;
  }

  // The remaining shortcuts only apply while the find bar is open
  if (findBar.hidden) return;

  switch (e.key) {
    case "Escape":
      e.preventDefault();
      closeFindBar();
      break;
    case "Enter":   // Enter / Shift+Enter
    case "F3":      // F3 / Shift+F3
      e.preventDefault();
      if (findMatches.length) setActiveMatch(findActive + (e.shiftKey ? -1 : 1));
      break;
    case "ArrowDown":
      e.preventDefault();
      if (findMatches.length) setActiveMatch(findActive + 1);
      break;
    case "ArrowUp":
      e.preventDefault();
      if (findMatches.length) setActiveMatch(findActive - 1);
      break;
  }
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
// Runs up to OCR_WORKERS pages concurrently to keep all scheduler workers busy,
// and yields via requestIdleCallback so scrolling / on-demand renders stay snappy.
function startBackgroundIndexing(total) {
  const idle = (fn) =>
    window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 1500 }) : setTimeout(fn, 30);

  let next = 1;
  let active = 0;

  const pump = () => {
    while (active < OCR_WORKERS) {
      while (next <= total && renderedPages.has(next)) next++; // skip already-rendered
      if (next > total) break;

      const pageNum = next++;
      const wrapper = container.querySelector(`.page-wrapper[data-page-num="${pageNum}"]`);
      if (!wrapper) continue;

      active++;
      renderPage(pageNum, wrapper)
        .catch((err) => console.error(`[FindInImages] background index error on page ${pageNum}:`, err))
        .finally(() => {
          active--;
          if (next > total && active === 0) {
            status.textContent = `All ${total} page${total > 1 ? "s" : ""} ready — Ctrl+F to search`;
          } else {
            idle(pump);
          }
        });
    }
  };

  idle(pump);
}

// Fit-to-width scale for a page (capped so small pages don't blow up)
function pageScaleFor(page) {
  const containerWidth = container.clientWidth - 40; // account for padding
  const natural = page.getViewport({ scale: 1.0 });
  return containerWidth > 0 ? Math.min(2.0, containerWidth / natural.width) : 1.5;
}

// Render an offscreen, high-resolution canvas purely for OCR. We target ~3000px
// on the long edge (~360 DPI for a Letter page) so small text inside images is
// legible to Tesseract, independent of the on-screen display size.
const OCR_TARGET_WIDTH = 3000;
async function renderOCRCanvas(page) {
  const natural = page.getViewport({ scale: 1.0 });
  const scale = Math.max(2, Math.min(5, OCR_TARGET_WIDTH / natural.width));
  const vp = page.getViewport({ scale });

  const canvas = document.createElement("canvas"); // not attached to the DOM
  canvas.width  = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  await page.render({ canvasContext: ctx, viewport: vp }).promise;

  preprocessForOCR(ctx, canvas.width, canvas.height);
  return canvas;
}

// Targeted preprocessing for the two hardest OCR cases:
//   • low-contrast text → percentile contrast stretch (auto-levels)
//   • blurry text       → unsharp mask (re-sharpen glyph edges)
// Operates in grayscale; lets Tesseract do its own binarization afterward.
function preprocessForOCR(ctx, w, h) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const n = w * h;

  // 1. Grayscale + luminance histogram
  const gray = new Uint8ClampedArray(n);
  const hist = new Uint32Array(256);
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
    gray[p] = g;
    hist[g]++;
  }

  // 2. Contrast stretch between the 2nd and 98th percentiles (ignore outliers).
  //    Low-contrast pages get pushed toward full black/white; already-punchy
  //    pages are left essentially unchanged.
  const lo = histPercentile(hist, n, 0.02);
  const hi = histPercentile(hist, n, 0.98);
  const range = Math.max(1, hi - lo);
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = ((v - lo) * 255) / range;
  for (let p = 0; p < n; p++) gray[p] = lut[gray[p]];

  // 3. Unsharp mask: sharp = gray + amount * (gray - blurred)
  const blurred = boxBlur(gray, w, h, 2);
  const amount = 1.0;
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const v = gray[p] + amount * (gray[p] - blurred[p]);
    d[i] = d[i + 1] = d[i + 2] = v < 0 ? 0 : v > 255 ? 255 : v;
  }

  ctx.putImageData(img, 0, 0);
}

// Value at which the cumulative histogram reaches `frac` of all pixels.
function histPercentile(hist, total, frac) {
  const target = total * frac;
  let cum = 0;
  for (let v = 0; v < 256; v++) {
    cum += hist[v];
    if (cum >= target) return v;
  }
  return 255;
}

// Separable box blur with a sliding-window sum — O(n) per pass, independent of
// radius. Edges clamp to the nearest pixel.
function boxBlur(src, w, h, r) {
  const win = r * 2 + 1;
  const tmp = new Uint8ClampedArray(src.length);
  const out = new Uint8ClampedArray(src.length);
  for (let y = 0; y < h; y++) {            // horizontal
    const row = y * w;
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[row + clampIndex(k, w)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = (sum / win) | 0;
      sum += src[row + clampIndex(x + r + 1, w)] - src[row + clampIndex(x - r, w)];
    }
  }
  for (let x = 0; x < w; x++) {            // vertical
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += tmp[clampIndex(k, h) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = (sum / win) | 0;
      sum += tmp[clampIndex(y + r + 1, h) * w + x] - tmp[clampIndex(y - r, h) * w + x];
    }
  }
  return out;
}

function clampIndex(v, max) { return v < 0 ? 0 : v >= max ? max - 1 : v; }

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

  // Render at the device pixel ratio (capped) so text stays crisp on HiDPI /
  // Retina screens. Without this the 1× canvas gets upscaled by the browser and
  // looks like a low-res scan. Layout stays in CSS px; only the backing store grows.
  const outputScale = Math.min(window.devicePixelRatio || 1, 2);

  // Correct the placeholder to the page's real dimensions (CSS pixels)
  wrapper.style.width  = `${viewport.width}px`;
  wrapper.style.height = `${viewport.height}px`;

  const canvas = document.createElement("canvas");
  // Backing store is DPR-scaled (more pixels)…
  canvas.width  = Math.floor(viewport.width  * outputScale);
  canvas.height = Math.floor(viewport.height * outputScale);
  // …but it's displayed at CSS (viewport) size, so the browser downsamples → crisp
  canvas.style.width  = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;

  const textLayerDiv = document.createElement("div");
  textLayerDiv.className = "text-layer";
  textLayerDiv.style.height = `${viewport.height}px`;

  wrapper.appendChild(canvas);
  wrapper.appendChild(textLayerDiv);

  await page.render({
    canvasContext: canvas.getContext("2d"),
    viewport,
    // Scale the drawing to fill the DPR-scaled backing store
    transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null,
  }).promise;

  await processTextLayer(page, canvas, textLayerDiv, viewport, pageNum, pdfDoc.numPages)
    .catch((err) => console.error(`[FindInImages] Text layer failed on page ${pageNum}:`, err));

  // Pick up matches on this page if a search is active (debounced)
  scheduleFindRefresh();
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

  // 2. Decide whether to OCR. OCR when the page paints images (may contain text),
  //    OR when it has no extractable text at all — that page could be a scan or
  //    text converted to vector outlines, both invisible to getTextContent().
  const hasImages = await pageHasImages(page);
  const shouldOCR = hasImages || pdfBoxes.length === 0;

  console.log(
    `[FindInImages] Page ${pageNum}: ${pdfBoxes.length} PDF text items, hasImages=${hasImages}, OCR=${shouldOCR}`
  );

  // 3. Normal text page with no images — nothing to OCR.
  if (!shouldOCR) {
    updateStatus(pageNum, total, "text");
    return;
  }

  // 4. Page has images. Reuse cached OCR if available, else run OCR and store it.
  //    Cached words are normalized (0..1) so they're independent of DPR / scale.
  let normWords = await getCachedPage(cacheDocId, pageNum);

  if (normWords) {
    console.log(`[FindInImages] Page ${pageNum}: cache hit (${normWords.length} words)`);
  } else {
    updateStatus(pageNum, total, "ocr-start");

    // Render a dedicated HIGH-RESOLUTION canvas for OCR. The display canvas is
    // sized to the window and is often too low-res for small text inside images;
    // OCR needs ~300 DPI to read reliably. This canvas is offscreen and discarded
    // right after recognition to free memory.
    const ocrCanvas = await renderOCRCanvas(page);
    const ocrW = ocrCanvas.width, ocrH = ocrCanvas.height;
    const rawWords = await runOCR(ocrCanvas, pageNum);
    ocrCanvas.width = ocrCanvas.height = 0; // release the large backing store

    if (!rawWords) {
      updateStatus(pageNum, total, pdfBoxes.length > 0 ? "text" : "ocr-empty");
      return;
    }
    // Clean up OCR output and add correction variants before caching.
    // Coords normalized against the OCR canvas so they're resolution-independent.
    const words = postProcessWords(rawWords);
    normWords = normalizeWords(words, ocrW, ocrH);
    await setCachedPage(cacheDocId, pageNum, normWords);
    console.log(
      `[FindInImages] Page ${pageNum}: OCR ${rawWords.length} raw → ${words.length} words @ ${ocrW}px wide (cached)`
    );
  }

  // Denormalize to the text layer's CSS-pixel space (viewport size), NOT the
  // canvas backing-store size — the canvas is DPR-scaled but the text layer and
  // PDF text boxes live in CSS pixels. Using canvas dims here would offset OCR
  // text by the device pixel ratio.
  const absWords = denormalizeWords(normWords, viewport.width, viewport.height);
  const newWords = filterOverlappingWords(absWords, pdfBoxes);
  appendOCRTextLayer(textLayerDiv, newWords);

  updateStatus(pageNum, total, newWords.length > 0 ? "ocr-done" : (pdfBoxes.length > 0 ? "text" : "ocr-empty"));
}

// ── Coordinate normalization (for scale-independent caching) ─────────────────
// The `variant` flag is preserved so search-only words stay non-selectable
// even when restored from cache.
function normalizeWords(words, w, h) {
  return words.map((word) => ({
    text: word.text,
    variant: word.variant,
    bbox: { x0: word.bbox.x0 / w, y0: word.bbox.y0 / h, x1: word.bbox.x1 / w, y1: word.bbox.y1 / h },
  }));
}

function denormalizeWords(words, w, h) {
  return words.map((word) => ({
    text: word.text,
    variant: word.variant,
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

// ── OCR via a Tesseract scheduler (parallel workers) ─────────────────────────
// A scheduler distributes recognize jobs across several workers so multiple
// pages OCR concurrently. Worker count scales with CPU cores but is capped —
// each worker loads its own copy of the language model, so more = more memory.
// We leave one core for the UI/rendering.
const OCR_WORKERS = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));

let _schedulerPromise = null;

function getOCRScheduler() {
  if (_schedulerPromise) return _schedulerPromise;

  _schedulerPromise = (async () => {
    if (!window.Tesseract) {
      throw new Error("Tesseract not loaded — check that tesseract.min.js is in lib/tesseract/");
    }

    console.log(`[FindInImages] Starting OCR scheduler: ${OCR_WORKERS} worker(s), lang=${OCR_LANG}`);
    const scheduler = window.Tesseract.createScheduler();

    // Sparse-text page segmentation: "find as much text as possible, in no
    // particular order." Far better than the default layout analysis at picking
    // up table cells, captions, and scattered small text.
    const PSM = window.Tesseract.PSM;
    const sparse = (PSM && PSM.SPARSE_TEXT) || "11";

    // Spin up all workers in parallel so total init ≈ one worker's load time
    const workers = await Promise.all(
      Array.from({ length: OCR_WORKERS }, async () => {
        const w = await window.Tesseract.createWorker(OCR_LANG, 1, {
          workerPath: TESSERACT_WORKER_PATH,
          corePath:   TESSERACT_CORE_PATH,
          langPath:   TESSERACT_LANG_PATH, // bundled traineddata — no CDN
          workerBlobURL: false,
        });
        await w.setParameters({ tessedit_pageseg_mode: sparse });
        return w;
      })
    );
    workers.forEach((w) => scheduler.addWorker(w));

    console.log(`[FindInImages] OCR scheduler ready (${scheduler.getNumWorkers()} workers)`);
    return scheduler;
  })();

  return _schedulerPromise;
}

async function runOCR(canvas, pageNum) {
  try {
    const scheduler = await getOCRScheduler();
    console.log(`[FindInImages] Page ${pageNum}: queued for OCR…`);

    // Tesseract.js v5+ omits detailed results by default — request blocks so we
    // get the block→paragraph→line→word hierarchy with per-word bounding boxes.
    const { data } = await scheduler.addJob("recognize", canvas, {}, { blocks: true });

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
