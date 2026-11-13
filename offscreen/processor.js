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
import { ocrPage, OCR_WORKERS } from "./ocr.js";
import { embedLines } from "./embed.js";

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
  let ocr = await getCachedPage(docId, pageNum);

  if (!ocr) {
    const raw = await ocrPage(page, lang);
    if (!raw) return 0;
    ocr = {
      words: postProcessWords(raw.words).map((wd) => ({
        text: wd.text, variant: wd.variant, line: wd.line, bbox: wd.bbox,
      })),
      lines: raw.lines,
    };
    await setCachedPage(docId, pageNum, ocr);
  }
  if (!ocr.words.length) return 0;

  // In the DOM viewer, misread words got an extra invisible "search variant"
  // (he11o → hello). In a real PDF both copies would pollute selection and
  // double native-find counts, so embed a single form — the corrected one,
  // since it's what the visible image most likely says.
  const chosen = preferCorrected(ocr.words);

  // Map each OCR line into PDF user space (rotation-aware via the viewport
  // inverse), and drop words PDF.js already provides as real text.
  const vp = page.getViewport({ scale: 1.0 });
  const pdfLines = toPdfLines(chosen, ocr.lines, vp)
    .map((ln) => ({ ...ln, words: ln.words.filter((pw) => !isNativeDuplicate(pw, nativeBoxes)) }))
    .filter((ln) => ln.words.length);
  if (!pdfLines.length) return 0;

  const libPage = libDoc.getPage(pageNum - 1);
  const fontKey = libPage.node.newFontDictionary(font.name, font.ref);
  return embedLines(PDFLib, libPage, font, fontKey, pdfLines);
}

// Collapse {raw, variant} pairs (same bbox) to just the corrected variant.
function preferCorrected(words) {
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w.variant) continue; // handled when its raw twin is visited
    const nxt = words[i + 1];
    if (nxt && nxt.variant && sameBox(w.bbox, nxt.bbox)) {
      out.push({ text: nxt.text, bbox: w.bbox, line: w.line });
      i++; // skip the variant entry
    } else {
      out.push({ text: w.text, bbox: w.bbox, line: w.line });
    }
  }
  return out;
}

function sameBox(a, b) {
  return a.x0 === b.x0 && a.y0 === b.y0 && a.x1 === b.x1 && a.y1 === b.y1;
}

/**
 * Group words by OCR line and map each line to PDF user space.
 *
 * All words on a line share the line's baseline and one font size, and are
 * later written with real space characters between them. Positioning each word
 * on its own (as before) gave every word a different baseline and size, and
 * Chrome's PDF engine then often saw no gap between words ("orNot itrains") or
 * a line break inside a line — so searches containing spaces failed.
 *
 * The OCR boxes live in the rendered (possibly rotated) page image; mapping
 * points through viewport.convertToPdfPoint handles rotation and origin flips.
 * Lines read from the page turned a quarter clockwise (dir: 1, e.g. a chart's
 * y-axis title) have their coordinates in that turned page; mapping them back
 * first makes the same maths produce text running bottom-to-top.
 *
 * Returns [{ size, words: [{ text, x, y, ex, ey, w, angle, cx, cy }] }] where
 * (x,y)→(ex,ey) is the word's baseline in PDF space.
 */
function toPdfLines(words, lines, vp) {
  const W = vp.width, H = vp.height;
  const upright = (x, y) => vp.convertToPdfPoint(x * W, y * H);
  const turned = (x, y) => upright(y, 1 - x); // turned-page (x, y) → page
  const byLine = new Map();
  for (const wd of words) {
    if (!(wd.bbox.x1 > wd.bbox.x0) || !(wd.bbox.y1 > wd.bbox.y0)) continue;
    if (!byLine.has(wd.line)) byLine.set(wd.line, []);
    byLine.get(wd.line).push(wd);
  }

  const out = [];
  for (const [index, lineWords] of byLine) {
    lineWords.sort((a, b) => a.bbox.x0 - b.bbox.x0);
    const line = lines[index];
    const pt = line && line.dir === 1 ? turned : upright;
    const top = Math.min(...lineWords.map((w) => w.bbox.y0));
    const bottom = Math.max(...lineWords.map((w) => w.bbox.y1));
    // Baseline: Tesseract's per-line baseline when it has one; otherwise 80%
    // down the line's words (the old per-word estimate, applied per line).
    const bl = line && line.baseline;
    const baseY = bl
      ? (x) => bl.y0 + ((bl.y1 - bl.y0) * (x - bl.x0)) / (bl.x1 - bl.x0)
      : () => top + 0.8 * (bottom - top);

    // Font size = the line's height, so the highlight covers ascenders and
    // descenders of the visible words.
    const x0 = lineWords[0].bbox.x0;
    const [tx, ty] = pt(x0, top);
    const [bx, by] = pt(x0, bottom);
    const size = Math.hypot(bx - tx, by - ty);
    if (!(size > 0)) continue;

    const mapped = [];
    for (const wd of lineWords) {
      const [sx, sy] = pt(wd.bbox.x0, baseY(wd.bbox.x0));
      const [ex, ey] = pt(wd.bbox.x1, baseY(wd.bbox.x1));
      const w = Math.hypot(ex - sx, ey - sy);
      if (!(w > 0)) continue;
      mapped.push({
        text: wd.text, x: sx, y: sy, ex, ey, w,
        angle: Math.atan2(ey - sy, ex - sx),
        cx: (sx + ex) / 2, // baseline midpoint, used for native-text dedup
        cy: (sy + ey) / 2,
      });
    }
    if (mapped.length) out.push({ size, words: mapped });
  }
  return out;
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
