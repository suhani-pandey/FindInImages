/**
 * OCR utilities: high-resolution page rendering, preprocessing, and a
 * Tesseract scheduler pool (one pool per language).
 *
 * Chrome-free on purpose — asset URLs are derived from import.meta.url, so the
 * same module runs inside the extension's offscreen document and in a plain
 * HTTP test harness.
 */

const TESSERACT_WORKER_PATH = new URL("../lib/tesseract/worker.min.js", import.meta.url).href;
const TESSERACT_CORE_PATH   = new URL("../lib/tesseract/", import.meta.url).href;
// Bundled *.traineddata.gz live here — fully offline, no CDN fetch
const TESSERACT_LANG_PATH   = new URL("../lib/tesseract/lang", import.meta.url).href;

// Worker count scales with CPU cores but is capped — each worker loads its own
// copy of the language model, so more = more memory. One core stays free.
export const OCR_WORKERS = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));

// ── Scheduler pool (per language) ────────────────────────────────────────────
const schedulers = new Map(); // lang -> Promise<scheduler>

function getScheduler(lang) {
  let p = schedulers.get(lang);
  if (p) return p;

  p = (async () => {
    const Tesseract = globalThis.Tesseract;
    if (!Tesseract) {
      throw new Error("Tesseract not loaded — check that tesseract.min.js is in lib/tesseract/");
    }

    const scheduler = Tesseract.createScheduler();

    // Sparse-text page segmentation: "find as much text as possible, in no
    // particular order." Far better than the default layout analysis at picking
    // up table cells, captions, and scattered small text.
    const PSM = Tesseract.PSM;
    const sparse = (PSM && PSM.SPARSE_TEXT) || "11";

    // Spin up all workers in parallel so total init ≈ one worker's load time
    const workers = await Promise.all(
      Array.from({ length: OCR_WORKERS }, async () => {
        const w = await Tesseract.createWorker(lang, 1, {
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

    return scheduler;
  })();

  schedulers.set(lang, p);
  return p;
}

/**
 * Recognize a canvas. Returns a flat [{text, confidence, bbox}] list in canvas
 * pixel coordinates, or null on failure.
 */
export async function recognize(canvas, lang) {
  try {
    const scheduler = await getScheduler(lang);
    // Tesseract.js v5+ omits detailed results by default — request blocks so we
    // get the block→paragraph→line→word hierarchy with per-word bounding boxes.
    const { data } = await scheduler.addJob("recognize", canvas, {}, { blocks: true });
    return flattenWords(data.blocks);
  } catch (err) {
    console.error("[FindInImages] OCR error:", err);
    return null;
  }
}

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

// ── High-resolution OCR canvas ───────────────────────────────────────────────
// ~3000px on the long edge (~360 DPI for a Letter page) so small text inside
// images is legible to Tesseract.
const OCR_TARGET_WIDTH = 3000;

/**
 * Render a page to an offscreen, high-resolution, OCR-preprocessed canvas.
 * Returns { canvas, viewport }. Caller should zero the canvas dims when done
 * to release the large backing store.
 */
export async function renderOCRCanvas(page) {
  const natural = page.getViewport({ scale: 1.0 });
  const scale = Math.max(2, Math.min(5, OCR_TARGET_WIDTH / natural.width));
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement("canvas"); // not attached to the DOM
  canvas.width  = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  // "print" intent: no requestAnimationFrame pacing, so rendering keeps running
  // in hidden contexts (the offscreen document is never visible).
  await page.render({ canvasContext: ctx, viewport, intent: "print" }).promise;

  preprocessForOCR(ctx, canvas.width, canvas.height);
  return { canvas, viewport };
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

function histPercentile(hist, total, frac) {
  const target = total * frac;
  let cum = 0;
  for (let v = 0; v < 256; v++) {
    cum += hist[v];
    if (cum >= target) return v;
  }
  return 255;
}

// Separable box blur with a sliding-window sum — O(n) per pass.
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
