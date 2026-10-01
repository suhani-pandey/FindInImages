/**
 * Searchable-PDF processor.
 *
 * Takes a PDF URL, OCRs the pages that need it, and produces a byte-identical-
 * looking copy with an invisible text layer embedded — so Chrome's NATIVE
 * viewer (and its native Ctrl+F) can search text that lives inside images.
 * The user never sees a different viewer: the extension swaps the tab to the
 * searchable copy in the same built-in viewer.
 *
 * Chrome-free on purpose (asset URLs via import.meta.url, pdf-lib via the
 * PDFLib global) so the whole pipeline runs both in the extension's offscreen
 * document and in a plain HTTP test harness.
 */

import * as pdfjsLib from "../lib/pdfjs/pdf.min.mjs";
import { getCachedPage, setCachedPage, hashBytes } from "./cache.js";
import { postProcessWords } from "./ocr-postprocess.js";
import { renderOCRCanvas, recognize, OCR_WORKERS } from "./ocr.js";
import { embedWords } from "./embed.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("../lib/pdfjs/pdf.worker.min.mjs", import.meta.url).href;

// Operator codes that indicate the page paints a raster image (may contain text)
const IMAGE_OPS = new Set([
  pdfjsLib.OPS.paintImageXObject,
  pdfjsLib.OPS.paintInlineImageXObject,
  pdfjsLib.OPS.paintImageMaskXObject,
  pdfjsLib.OPS.paintImageXObjectRepeat,
]);

/**
 * Process one PDF.
 *
 * @param {string}   url         PDF URL (http/https/file)
 * @param {string}   lang        Tesseract language ("eng", "dan", "eng+dan")
 * @param {function} onProgress  (donePages, totalPages) => void
 * @returns {Promise<{bytes: Uint8Array|null, pages: number, words: number}>}
 *          bytes is null when no page needed OCR text (already searchable).
 */
export async function processPdf(url, lang, onProgress = () => {}) {
  const original = await downloadPdf(url);

  const PDFLib = globalThis.PDFLib;
  if (!PDFLib) throw new Error("pdf-lib not loaded");

  // pdf.js transfers its input buffer to the worker, so give it a copy and
  // keep `original` intact for pdf-lib. The loading task owns the pdf.js
  // worker; it's destroyed in `finally` because the offscreen document lives
  // all session and would otherwise keep every processed PDF in memory.
  const loadingTask = pdfjsLib.getDocument({ data: original.slice() });
  try {
    let pdfDoc, libDoc, hash;
    try {
      [pdfDoc, libDoc, hash] = await Promise.all([
        loadingTask.promise,
        PDFLib.PDFDocument.load(original, { updateMetadata: false }),
        hashBytes(original),
      ]);
    } catch (err) {
      if (isEncryptionError(err)) {
        throw new Error("This PDF is password-protected or encrypted, so it can't be made searchable");
      }
      throw err;
    }

    const docId = `${hash}::${lang}`;
    const font = await libDoc.embedFont(PDFLib.StandardFonts.Helvetica);
    const total = pdfDoc.numPages;
    let wordsAdded = 0;
    let done = 0;

    // Process pages with a small concurrency pool so all OCR workers stay busy.
    // JS is single-threaded, so interleaved pdf-lib mutations on different pages
    // are safe; only the OCR/render awaits actually overlap.
    let next = 1;
    const worker = async () => {
      while (next <= total) {
        const pageNum = next++;
        try {
          wordsAdded += await processPage(pdfDoc, libDoc, font, pageNum, docId, lang, PDFLib);
        } catch (err) {
          console.error(`[FindInImages] page ${pageNum} failed:`, err);
        }
        done++;
        onProgress(done, total);
      }
    };
    await Promise.all(Array.from({ length: Math.min(OCR_WORKERS, total) }, worker));

    if (wordsAdded === 0) return { bytes: null, pages: total, words: 0 };

    const bytes = await libDoc.save();
    return { bytes, pages: total, words: wordsAdded };
  } finally {
    loadingTask.destroy();
  }
}

// ── Download ──────────────────────────────────────────────────────────────────
async function downloadPdf(url) {
  let resp;
  try {
    // Send the user's cookies so PDFs behind a sign-in (course portals,
    // intranets) download the same file the tab is showing.
    resp = await fetch(url, { credentials: "include" });
  } catch {
    throw new Error("Couldn't download the PDF (network error)");
  }
  if (!resp.ok) throw new Error(`Couldn't download the PDF (HTTP ${resp.status})`);
  const bytes = new Uint8Array(await resp.arrayBuffer());

  // The trigger accepts any URL (plenty of PDFs are served without ".pdf" in
  // the link), so this is where non-PDF pages get turned away.
  if (!looksLikePdf(bytes)) {
    const isHtml = /html/i.test(resp.headers.get("content-type") || "");
    throw new Error(
      isHtml
        ? "This page isn't a PDF (or the PDF's link now returns a web page, such as a sign-in page)"
        : "This file isn't a PDF"
    );
  }
  return bytes;
}

// PDF files start with "%PDF-"; readers accept up to 1 KB of junk before it.
function looksLikePdf(bytes) {
  const head = bytes.subarray(0, 1024);
  for (let i = 0; i + 4 < head.length; i++) {
    if (head[i] === 0x25 && head[i + 1] === 0x50 && head[i + 2] === 0x44 &&
        head[i + 3] === 0x46 && head[i + 4] === 0x2d) return true; // "%PDF-"
  }
  return false;
}

// pdf.js throws PasswordException when a password is needed. pdf-lib refuses
// any encrypted file, but its error class is transpiled ES5, so `instanceof`
// doesn't work on it — match its message instead.
function isEncryptionError(err) {
  return !!err && (err.name === "PasswordException" || /\bis encrypted\b/i.test(err.message || ""));
}

// ── Per-page pipeline ─────────────────────────────────────────────────────────
async function processPage(pdfDoc, libDoc, font, pageNum, docId, lang, PDFLib) {
  const page = await pdfDoc.getPage(pageNum);

  let textContent;
  try {
    textContent = await page.getTextContent();
  } catch {
    textContent = { items: [] };
  }
  const nativeBoxes = nativeTextBoxes(textContent);

  // OCR when the page paints images (they may contain text), OR when it has no
  // extractable text at all (scan, or text converted to vector outlines).
  const hasImages = await pageHasImages(page);
  if (!hasImages && nativeBoxes.length > 0) return 0;

  // Cached OCR results are normalized (0..1 of the rendered page) so they're
  // scale-independent. docId = content hash + language.
  let normWords = await getCachedPage(docId, pageNum);

  if (!normWords) {
    const { canvas } = await renderOCRCanvas(page);
    const w = canvas.width, h = canvas.height;
    const raw = await recognize(canvas, lang);
    canvas.width = canvas.height = 0; // release the large backing store
    if (!raw) return 0;
    const words = postProcessWords(raw);
    normWords = words.map((wd) => ({
      text: wd.text,
      variant: wd.variant,
      bbox: { x0: wd.bbox.x0 / w, y0: wd.bbox.y0 / h, x1: wd.bbox.x1 / w, y1: wd.bbox.y1 / h },
    }));
    await setCachedPage(docId, pageNum, normWords);
  }
  if (!normWords.length) return 0;

  // In the DOM viewer, misread words got an extra invisible "search variant"
  // (he11o → hello). In a real PDF both copies would pollute selection and
  // double native-find counts, so embed a single form — the corrected one,
  // since it's what the visible image most likely says.
  const chosen = preferCorrected(normWords);

  // Map normalized visual coords → PDF user space (rotation-aware via the
  // viewport inverse), and drop words PDF.js already provides as real text.
  const vp = page.getViewport({ scale: 1.0 });
  const pdfWords = [];
  for (const wd of chosen) {
    const pw = toPdfWord(wd, vp);
    if (!pw) continue;
    if (isNativeDuplicate(pw, nativeBoxes)) continue;
    pdfWords.push(pw);
  }
  if (!pdfWords.length) return 0;

  const libPage = libDoc.getPage(pageNum - 1);
  const fontKey = libPage.node.newFontDictionary(font.name, font.ref);
  return embedWords(PDFLib, libPage, font, fontKey, pdfWords);
}

// Collapse {raw, variant} pairs (same bbox) to just the corrected variant.
function preferCorrected(words) {
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w.variant) continue; // handled when its raw twin is visited
    const nxt = words[i + 1];
    if (nxt && nxt.variant && sameBox(w.bbox, nxt.bbox)) {
      out.push({ text: nxt.text, bbox: w.bbox });
      i++; // skip the variant entry
    } else {
      out.push({ text: w.text, bbox: w.bbox });
    }
  }
  return out;
}

function sameBox(a, b) {
  return a.x0 === b.x0 && a.y0 === b.y0 && a.x1 === b.x1 && a.y1 === b.y1;
}

/**
 * Convert one normalized visual-space word to PDF user space.
 *
 * The OCR bbox lives in the rendered (possibly rotated) page image; mapping
 * its baseline endpoints through viewport.convertToPdfPoint handles rotation
 * and origin flips in one place. Font size comes from the mapped box height,
 * the baseline angle from the mapped endpoints.
 */
function toPdfWord(word, vp) {
  const { x0, y0, x1, y1 } = word.bbox;
  const w = x1 - x0, h = y1 - y0;
  if (w <= 0 || h <= 0) return null;

  const W = vp.width, H = vp.height;
  const baseY = (y0 + 0.8 * h) * H; // baseline ≈ 80% down the box

  const [sx, sy] = vp.convertToPdfPoint(x0 * W, baseY);
  const [ex, ey] = vp.convertToPdfPoint(x1 * W, baseY);
  const [tx, ty] = vp.convertToPdfPoint(x0 * W, y0 * H);
  const [bx, by] = vp.convertToPdfPoint(x0 * W, y1 * H);

  const width  = Math.hypot(ex - sx, ey - sy);
  const height = Math.hypot(bx - tx, by - ty);
  if (width <= 0 || height <= 0) return null;

  return {
    text: word.text,
    x: sx,
    y: sy,
    w: width,
    h: height,
    angle: Math.atan2(ey - sy, ex - sx),
    cx: (sx + ex) / 2, // baseline midpoint, used for native-text dedup
    cy: (sy + ey) / 2,
  };
}

// ── Native PDF text (for dedup) ──────────────────────────────────────────────
// getTextContent item transforms are already in PDF user space: origin at the
// baseline start, height ≈ font size (ascent above, none below). The box is
// padded a quarter-em below the baseline so descenders/centers still hit it.
function nativeTextBoxes(textContent) {
  const boxes = [];
  for (const item of textContent.items) {
    if (!item.str || !item.str.trim()) continue;
    const tx = item.transform;
    const h = item.height || Math.hypot(tx[2], tx[3]) || 1;
    boxes.push({
      x: tx[4],
      y: tx[5] - 0.25 * h,
      w: item.width || h,
      h: h * 1.25,
      text: normalizeText(item.str),
    });
  }
  return boxes;
}

// An OCR word is a duplicate when its baseline midpoint falls inside a native
// text box whose text already contains the word — i.e. OCR simply re-read text
// PDF.js already provides. Different text at the same spot (text baked into an
// image near native text) is kept.
function isNativeDuplicate(pw, nativeBoxes) {
  if (!nativeBoxes.length) return false;
  const norm = normalizeText(pw.text);
  if (!norm) return true; // pure punctuation/noise — nothing to gain
  return nativeBoxes.some(
    (b) =>
      pw.cx >= b.x && pw.cx <= b.x + b.w &&
      pw.cy >= b.y && pw.cy <= b.y + b.h &&
      b.text.includes(norm)
  );
}

function normalizeText(s) {
  return s.toLowerCase().replace(/[^a-z0-9æøåäöüß]/g, "");
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
