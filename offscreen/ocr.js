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

// ── OCR engines (per language) ───────────────────────────────────────────────
// A pool of workers in sparse-text mode ("find as much text as possible, in no
// particular order" — far better than the default layout analysis at table
// cells, captions and scattered small text) reads whole pages. One extra
// worker in automatic (block) mode gives coloured areas a second opinion: on
// small capitals in tiles each mode reads words the other misses.
const engines = new Map(); // lang -> Promise<{ sparse: scheduler, block: worker }>

function getEngines(lang) {
  let p = engines.get(lang);
  if (p) return p;

  p = (async () => {
    const Tesseract = globalThis.Tesseract;
    if (!Tesseract) {
      throw new Error("Tesseract not loaded — check that tesseract.min.js is in lib/tesseract/");
    }
    const PSM = Tesseract.PSM || {};
    const create = async (mode) => {
      const w = await Tesseract.createWorker(lang, 1, {
        workerPath: TESSERACT_WORKER_PATH,
        corePath:   TESSERACT_CORE_PATH,
        langPath:   TESSERACT_LANG_PATH, // bundled traineddata — no CDN
        workerBlobURL: false,
      });
      await w.setParameters({ tessedit_pageseg_mode: mode });
      return w;
    };

    // Spin up all workers in parallel so total init ≈ one worker's load time
    const [block, ...sparseWorkers] = await Promise.all([
      create(PSM.AUTO || "3"),
      ...Array.from({ length: OCR_WORKERS }, () => create(PSM.SPARSE_TEXT || "11")),
    ]);
    const sparse = Tesseract.createScheduler();
    sparseWorkers.forEach((w) => sparse.addWorker(w));
    return { sparse, block };
  })();

  engines.set(lang, p);
  return p;
}

/**
 * Terminate all OCR workers (they're recreated on the next page).
 */
export async function releaseWorkers() {
  const all = [...engines.values()];
  engines.clear();
  await Promise.all(all.map((p) =>
    p.then((e) => Promise.all([e.sparse.terminate(), e.block.terminate()])).catch(() => {})));
}

/**
 * OCR one PDF page (a PDF.js page proxy).
 *
 * Three passes: the whole page at ~360 DPI; each coloured or dark area —
 * white text on orange tiles, dark buttons, banners — re-rendered from the PDF
 * at up to 3x the resolution and read on its own (recognizeColorRegions); and
 * the page turned a quarter clockwise, for text running bottom-to-top such as
 * chart axis labels (recognizeSideways).
 *
 * Returns { words, lines } or null on failure, in coordinates normalized to
 * 0..1 of the page as displayed — or, for lines with dir: 1, of the page
 * turned a quarter clockwise (x across the turned page, y down it):
 *   words: [{ text, confidence, bbox, line }]   line = index into lines
 *   lines: [{ bbox, baseline, dir? }]           baseline = {x0,y0,x1,y1} | null
 * Lines matter: words are later written into the PDF line by line, with real
 * space characters between them, so Chrome's search sees "Not now", not "Notnow".
 */
export async function ocrPage(page, lang) {
  let canvas = null;
  try {
    const ocr = await getEngines(lang);
    const scale = pageScale(page);
    canvas = await renderRegion(page, scale);
    const width = canvas.width, height = canvas.height;
    const regions = colorRegions(canvas); // found on the colours, before graying
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    preprocessForOCR(ctx, width, height);
    const result = await recognizeCanvas(ocr.sparse, canvas);
    canvas.width = canvas.height = 0; // release the large backing store
    await recognizeColorRegions(ocr, page, scale, regions, result);

    const upright = normalize(result, width, height);
    const sideways = await recognizeSideways(ocr.sparse, page, upright.words);
    const offset = upright.lines.length;
    return {
      words: upright.words.concat(sideways.words.map((wd) => ({ ...wd, line: wd.line + offset }))),
      lines: upright.lines.concat(sideways.lines),
    };
  } catch (err) {
    console.error("[FindInImages] OCR error:", err);
    return null;
  } finally {
    if (canvas) canvas.width = canvas.height = 0;
  }
}

function normalize({ words, lines }, W, H, extra = {}) {
  const n = (b) => b && { x0: b.x0 / W, y0: b.y0 / H, x1: b.x1 / W, y1: b.y1 / H };
  return {
    words: words.map((wd) => ({ ...wd, bbox: n(wd.bbox) })),
    lines: lines.map((ln) => ({ bbox: n(ln.bbox), baseline: n(ln.baseline), ...extra })),
  };
}

// ── Sideways text ────────────────────────────────────────────────────────────
// Tesseract only reads horizontal lines, so vertical text — a chart's y-axis
// title, a label up the side of a table — is missed entirely. Turning the page
// a quarter clockwise makes bottom-to-top text (by far the usual direction)
// horizontal. Everything else is then sideways and mostly read as junk, so
// only confident words that don't cover anything the upright pass found are
// kept. Done at a lower resolution: such labels are rarely tiny.
const SIDEWAYS_MAX_SIDE = 2400;
const SIDEWAYS_CONFIDENCE = 80;

async function recognizeSideways(engine, page, uprightWords) {
  const natural = page.getViewport({ scale: 1.0 });
  const scale = Math.min(pageScale(page), SIDEWAYS_MAX_SIDE / Math.max(natural.width, natural.height));
  const src = await renderRegion(page, scale);
  const W = src.width, H = src.height;
  const turned = document.createElement("canvas");
  turned.width = H;
  turned.height = W;
  const ctx = turned.getContext("2d", { willReadFrequently: true });
  // (x, y) on the page → (H - y, x) on the turned canvas
  ctx.translate(H, 0);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(src, 0, 0);
  src.width = src.height = 0;
  preprocessForOCR(ctx, H, W);
  const found = await recognizeCanvas(engine, turned);
  turned.width = turned.height = 0;

  const { words, lines } = normalize(found, H, W, { dir: 1 });
  // A turned-page box (u, v) covers page area x ∈ [v0, v1], y ∈ [1 - u1, 1 - u0].
  const onPage = (b) => ({ x0: b.y0, y0: 1 - b.x1, x1: b.y1, y1: 1 - b.x0 });
  // Only real upright words block a sideways one: the upright pass reads
  // vertical text as junk ("3308", "p") right where it is.
  const real = uprightWords.filter((up) => isSolidWord(up) && /\p{L}.*\p{L}/u.test(up.text));
  const kept = words.filter((wd) =>
    isSolidWord(wd) && wd.confidence >= SIDEWAYS_CONFIDENCE &&
    !real.some((up) => overlaps(up.bbox, onPage(wd.bbox))));
  return { words: kept, lines };
}

// `engine` is the sparse scheduler or the block worker. `map` converts
// Tesseract's pixel boxes into page-rendering pixels (used when the canvas is
// a zoomed-in part of the page).
async function recognizeCanvas(engine, canvas, map = (b) => b) {
  // Tesseract.js v5+ omits detailed results by default — request blocks so we
  // get the block→paragraph→line→word hierarchy with per-word bounding boxes.
  const { data } = engine.addJob
    ? await engine.addJob("recognize", canvas, {}, { blocks: true })
    : await engine.recognize(canvas, {}, { blocks: true });
  return flatten(data.blocks, map);
}

function flatten(blocks, map) {
  const box = (b) => map({ x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 });
  const words = [], lines = [];
  for (const block of blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        const lineWords = (line.words ?? []).filter((w) => w.text && w.bbox);
        if (!lineWords.length) continue;
        const bl = line.baseline;
        lines.push({
          bbox: box(line.bbox),
          baseline: bl && bl.has_baseline !== false && bl.x1 > bl.x0 ? box(bl) : null,
        });
        for (const w of lineWords) {
          words.push({ text: w.text, confidence: w.confidence, bbox: box(w.bbox), line: lines.length - 1 });
        }
      }
    }
  }
  return { words, lines };
}

// ── Coloured and dark areas ──────────────────────────────────────────────────
// Tesseract reads dark text on light backgrounds well, but small light text on
// colour — the white capitals on orange/red SDG tiles, white-on-dark buttons —
// mostly comes out as fragments or nothing: in grayscale white on orange is
// barely any contrast, and the page pass is too coarse for 5-pt labels. So
// coloured areas are found on the original colours, re-rendered from the PDF
// at a higher resolution, converted with the DARKEST colour channel (white
// text stays white, any saturated or dark background goes dark), inverted to
// dark-on-light, and read on their own. For each area, whichever pass read
// more of it (see readingScore) keeps it: a coloured photo with a dark caption
// is better read by the page pass, a tile of white capitals by the zoomed one.
const REGION_TILE = 24;          // px at page OCR resolution (~5-8 pt)
const REGION_LEVEL = 120;        // tile's mean darkest channel below this = coloured/dark
const REGION_MIN_TILES = 12;     // ignore specks (e.g. strokes of bold headings)
const REGION_ZOOM = 3;           // up to 3x the page resolution…
const REGION_MAX_PIXELS = 8e6;   // …within this many pixels per area
const PAGE_REGION_PIXELS = 60e6; // and this many per page (photos can be huge)

async function recognizeColorRegions(ocr, page, scale, regions, result) {
  // Choose zooms within the page's pixel budget up front, then read the areas
  // concurrently (the sparse pool has several workers).
  let budget = PAGE_REGION_PIXELS;
  const jobs = [];
  for (const reg of regions) {
    const w = reg.x1 - reg.x0, h = reg.y1 - reg.y0;
    const zoom = Math.max(1, Math.min(REGION_ZOOM, Math.sqrt(REGION_MAX_PIXELS / (w * h))));
    if (w * h * zoom * zoom > budget) continue;
    budget -= w * h * zoom * zoom;
    jobs.push({ reg, zoom });
  }
  let next = 0;
  const run = async () => {
    while (next < jobs.length) {
      const { reg, zoom } = jobs[next++];
      await recognizeColorRegion(ocr, page, scale, reg, zoom, result);
    }
  };
  await Promise.all(Array.from({ length: Math.min(OCR_WORKERS, jobs.length) }, run));
}

async function recognizeColorRegion(ocr, page, scale, reg, zoom, result) {
  const inside = (b) => {
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    return cx >= reg.x0 && cx <= reg.x1 && cy >= reg.y0 && cy <= reg.y1;
  };
  const w = reg.x1 - reg.x0, h = reg.y1 - reg.y0;
  const crop = await renderRegion(page, scale * zoom, {
    x: reg.x0 / scale, y: reg.y0 / scale, w: w / scale, h: h / scale,
  });
  const ctx = crop.getContext("2d", { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, crop.width, crop.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = d[i + 1] = d[i + 2] = 255 - Math.min(d[i], d[i + 1], d[i + 2]);
  }
  ctx.putImageData(img, 0, 0);

  const map = (b) => ({
    x0: reg.x0 + b.x0 / zoom, y0: reg.y0 + b.y0 / zoom,
    x1: reg.x0 + b.x1 / zoom, y1: reg.y0 + b.y1 / zoom,
  });
  const found = [await recognizeCanvas(ocr.sparse, crop, map)];
  // The block-mode second opinion only where the zoomed reading is unsure: a
  // real word read with low confidence. Clearly read areas and pure graphics
  // (bars, photos) don't need it — and it has a single worker.
  if (found[0].words.some((wd) => wd.confidence < 85 && (wd.text.match(/\p{L}/gu) || []).length >= 3)) {
    found.push(await recognizeCanvas(ocr.block, crop, map));
  }
  crop.width = crop.height = 0;

  // No awaits from here on: concurrent areas never interleave their updates.
  const readings = [result.words.filter((wd) => inside(wd.bbox))];
  for (const f of found) {
    const base = result.lines.length;
    result.lines.push(...f.lines);
    readings.push(f.words
      .filter((wd) => wd.confidence >= 60 && /[\p{L}\p{N}]/u.test(wd.text))
      .map((wd) => ({ ...wd, line: base + wd.line })));
  }

  // At these sizes OCR is fickle: each reading gets words the others miss.
  // Keep the reading with the most real text, then fill its gaps with
  // confidently read words from the others.
  readings.sort((a, b) => readingScore(b) - readingScore(a));
  const merged = [...readings[0]];
  for (const other of readings.slice(1)) {
    for (const wd of other) {
      if (isSolidWord(wd) && !merged.some((m) => overlaps(m.bbox, wd.bbox))) merged.push(wd);
    }
  }
  result.words = result.words.filter((wd) => !inside(wd.bbox)).concat(merged);
}

// A confidently read word with at least two letters (or three digits).
function isSolidWord(wd) {
  const letters = (wd.text.match(/\p{L}/gu) || []).length;
  const digits = (wd.text.match(/\p{N}/gu) || []).length;
  return wd.confidence >= 80 && (letters >= 2 || digits >= 3);
}

// Boxes covering the same spot: their overlap is over a third of the smaller box.
function overlaps(a, b) {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  if (w <= 0 || h <= 0) return false;
  const area = (r) => (r.x1 - r.x0) * (r.y1 - r.y0);
  return w * h > Math.min(area(a), area(b)) / 3;
}

// How much real text a set of words holds: letters in confidently read words
// that contain at least two letters (digits and stray marks like "|" or "1"
// on an icon don't count).
function readingScore(words) {
  let score = 0;
  for (const wd of words) {
    const letters = (wd.text.match(/\p{L}/gu) || []).length;
    if (wd.confidence >= 60 && letters >= 2) score += letters;
  }
  return score;
}

// Tiles whose darkest colour channel is low on average (saturated colour or
// dark), merged into connected rectangles.
function colorRegions(canvas) {
  const T = REGION_TILE;
  const w = canvas.width, h = canvas.height;
  const d = canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const cols = Math.floor(w / T), rows = Math.floor(h / T);
  const marked = new Uint8Array(cols * rows);
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      let sum = 0, n = 0;
      for (let y = ty * T; y < ty * T + T; y += 3) {
        for (let x = tx * T; x < tx * T + T; x += 3) {
          const i = (y * w + x) * 4;
          sum += Math.min(d[i], d[i + 1], d[i + 2]);
          n++;
        }
      }
      if (sum / n < REGION_LEVEL) marked[ty * cols + tx] = 1;
    }
  }
  const seen = new Uint8Array(cols * rows);
  const regions = [];
  for (let i = 0; i < cols * rows; i++) {
    if (!marked[i] || seen[i]) continue;
    const stack = [i];
    seen[i] = 1;
    let x0 = cols, y0 = rows, x1 = -1, y1 = -1, n = 0;
    while (stack.length) {
      const j = stack.pop();
      const tx = j % cols, ty = (j / cols) | 0;
      n++;
      x0 = Math.min(x0, tx); x1 = Math.max(x1, tx);
      y0 = Math.min(y0, ty); y1 = Math.max(y1, ty);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = tx + dx, ny = ty + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const k = ny * cols + nx;
        if (marked[k] && !seen[k]) { seen[k] = 1; stack.push(k); }
      }
    }
    if (n >= REGION_MIN_TILES && x1 - x0 >= 3 && y1 > y0) {
      regions.push({ x0: x0 * T, y0: y0 * T, x1: (x1 + 1) * T, y1: (y1 + 1) * T });
    }
  }
  return regions;
}

// ── High-resolution OCR canvas ───────────────────────────────────────────────
// ~3000px on the long edge (~360 DPI for a Letter page) so small text inside
// images is legible to Tesseract.
const OCR_TARGET_WIDTH = 3000;

// Page OCR resolution: ~3000 px across the page's width, between 2x and 5x.
function pageScale(page) {
  const natural = page.getViewport({ scale: 1.0 });
  return Math.max(2, Math.min(5, OCR_TARGET_WIDTH / natural.width));
}

/**
 * Render a page — or with `rect` = {x, y, w, h} (PDF.js viewport units at
 * scale 1, top-left origin) just that part of it — to a new canvas at `scale`.
 */
async function renderRegion(page, scale, rect) {
  const natural = page.getViewport({ scale: 1.0 });
  const r = rect || { x: 0, y: 0, w: natural.width, h: natural.height };
  const viewport = page.getViewport({ scale, offsetX: -r.x * scale, offsetY: -r.y * scale });
  const canvas = document.createElement("canvas"); // not attached to the DOM
  canvas.width = Math.max(1, Math.floor(r.w * scale));
  canvas.height = Math.max(1, Math.floor(r.h * scale));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  // "print" intent: no requestAnimationFrame pacing, so rendering keeps running
  // in hidden contexts (the offscreen document is never visible).
  await page.render({ canvasContext: ctx, viewport, intent: "print" }).promise;
  return canvas;
}

// Smallest gray-level span the contrast stretch maps onto 0..255 (max gain ≈2.7×).
const MIN_STRETCH_RANGE = 96;

// Targeted preprocessing for the hardest OCR cases:
//   • low-contrast text → percentile contrast stretch (auto-levels)
//   • blurry text       → unsharp mask (re-sharpen glyph edges)
//   • text in tables and boxes → remove thin ruling lines
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

  // 2. Contrast stretch between the 2nd and 98th percentiles (ignore outliers),
  //    anchored at the white point. On a mostly blank page (a receipt, a cover)
  //    text is under 2% of the pixels, so the 2nd percentile is background too;
  //    the range floor caps the gain so JPEG noise isn't stretched into black
  //    speckles that bury the text.
  const lo = histPercentile(hist, n, 0.02);
  const hi = histPercentile(hist, n, 0.98);
  const range = Math.max(MIN_STRETCH_RANGE, hi - lo);
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = 255 - ((hi - v) * 255) / range;
  for (let p = 0; p < n; p++) gray[p] = lut[gray[p]];

  // 3. Unsharp mask: sharp = gray + amount * (gray - blurred)
  const blurred = boxBlur(gray, w, h, 2);
  const amount = 1.0;
  const sharp = new Uint8ClampedArray(n);
  for (let p = 0; p < n; p++) sharp[p] = gray[p] + amount * (gray[p] - blurred[p]);

  // 4. Table borders and box outlines touching the text make Tesseract merge
  //    them into the text row and misread it ("Status | Not started" came out
  //    as "ttn Notes"), so erase them first.
  removeThinLines(sharp, w, h);

  for (let p = 0, i = 0; p < n; p++, i += 4) d[i] = d[i + 1] = d[i + 2] = sharp[p];
  ctx.putImageData(img, 0, 0);
}

// Erase long, THIN dark lines: a horizontal (or vertical) run of dark pixels at
// least ~4% of the page width whose pixels a few px above and below (left and
// right) are mostly light. Thick strokes — big heading letters, filled boxes —
// fail the thinness test and stay. A plain "long run" test would erase the
// stems of large headings ("IT IS NOT LATE" became "S \C").
// Lines are found on a slightly lighter threshold than text, because thin gray
// borders are anti-aliased to mid-gray, and runs may skip a few pixels (JPEG
// noise, crossings). A table whose horizontal borders are erased but whose
// vertical ones survive reads WORSE than the untouched table ("Invoice" became
// "Tayoice"), so both directions must be caught.
function removeThinLines(g, w, h) {
  const LINE = 170;
  const GAP = 3;
  const minRun = Math.round(w / 25);
  const side = Math.max(6, Math.round(w / 375));
  const dark = (x, y) => x >= 0 && y >= 0 && x < w && y < h && g[y * w + x] < LINE;
  const erase = new Uint8Array(w * h);

  // Scan one row (or column) for long runs and mark the thin ones. at(i) gives
  // the pixel index of position i along the scan; sideDark(i) whether the
  // pixels `side` away across the run are dark.
  const scan = (len, at, sideDark) => {
    let start = -1, last = -1;
    const finish = () => {
      if (start >= 0 && last - start + 1 >= minRun) {
        let thick = 0;
        for (let i = start; i <= last; i++) if (sideDark(i)) thick++;
        if (thick / (last - start + 1) < 0.2) for (let i = start; i <= last; i++) erase[at(i)] = 1;
      }
      start = -1;
    };
    for (let i = 0; i < len; i++) {
      if (g[at(i)] < LINE) {
        if (start >= 0 && i - last > GAP + 1) finish();
        if (start < 0) start = i;
        last = i;
      }
    }
    finish();
  };

  for (let y = 0; y < h; y++) scan(w, (x) => y * w + x, (x) => dark(x, y - side) || dark(x, y + side));
  for (let x = 0; x < w; x++) scan(h, (y) => y * w + x, (y) => dark(x - side, y) || dark(x + side, y));
  for (let p = 0; p < w * h; p++) if (erase[p]) g[p] = 255;
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
