/**
 * Text layer injection utilities.
 *
 * Two sources of text are supported and can coexist on the same page:
 *  1. PDF.js native — from getTextContent() (accurate, for real PDF text)
 *  2. OCR — from Tesseract.js (for text baked into images)
 *
 * Both produce invisible <span> elements absolutely positioned over the canvas
 * so the browser's native Ctrl+F can find them.
 *
 * Coordinate note: the canvas intrinsic resolution equals the scaled viewport
 * size, so PDF viewport coordinates and OCR pixel coordinates share the same
 * space — boxes from both can be compared directly for de-duplication.
 */

/**
 * Inject text extracted by PDF.js into the text layer div.
 * Clears the layer first (this is always the first injection for a page).
 *
 * @param {HTMLDivElement} textLayerDiv
 * @param {object}         textContent   — result of page.getTextContent()
 * @param {object}         viewport      — PDF.js viewport object
 * @returns {Array<{x:number,y:number,w:number,h:number}>} boxes of injected text
 */
export function injectPDFTextLayer(textLayerDiv, textContent, viewport) {
  textLayerDiv.innerHTML = "";
  const boxes = [];
  const vt = viewport.transform; // device-space matrix (already includes page rotation)
  const entries = [];
  const frag = document.createDocumentFragment();

  // ── Pass 1: create each span at its position, sized by font height only ──────
  for (const item of textContent.items) {
    if (!item.str || !item.str.trim()) continue;

    // Combine the viewport transform with the item's own transform to get the
    // glyph's full matrix in device (canvas) space. This is what makes rotated
    // pages and rotated text align correctly — angle falls out of the matrix.
    const tx = matMul(vt, item.transform);

    const angle      = Math.atan2(tx[1], tx[0]);              // text baseline angle
    const fontHeight = Math.max(1, Math.hypot(tx[2], tx[3])); // device-space height
    const fontAscent = fontHeight * 0.8;                      // approx ascent above baseline
    // Rotation preserves lengths and the viewport scale is uniform, so the
    // device-space run width is simply the PDF-space width times the scale.
    const targetWidth = Math.abs(item.width) * viewport.scale;

    // Move from baseline origin to the span's top-left, along the text's angle
    let left, top;
    if (angle === 0) {
      left = tx[4];
      top  = tx[5] - fontAscent;
    } else {
      left = tx[4] + fontAscent * Math.sin(angle);
      top  = tx[5] - fontAscent * Math.cos(angle);
    }

    const span = document.createElement("span");
    span.textContent = item.str; // no trailing space yet — measured below
    span.style.left     = `${left}px`;
    span.style.top      = `${top}px`;
    span.style.fontSize = `${fontHeight}px`;
    frag.appendChild(span);

    entries.push({ span, str: item.str, angle, left, top, fontHeight, targetWidth });
  }

  textLayerDiv.appendChild(frag); // single DOM insertion

  // ── Pass 2 (read): measure each span's natural rendered width (one layout) ───
  for (const e of entries) {
    e.measured = e.span.offsetWidth || 1;
  }

  // ── Pass 3 (write): scale each span to EXACTLY the run's device width, so the
  //    invisible glyphs line up with the canvas. Measuring (not estimating) is
  //    what makes selection and Find land on the right characters. The trailing
  //    space is added after measuring so it doesn't skew the scale. ────────────
  for (const e of entries) {
    const sx = e.targetWidth > 0 ? e.targetWidth / e.measured : 1;
    const scaleX = isFinite(sx) && sx > 0 ? sx : 1;

    e.span.style.transform = e.angle === 0
      ? `scaleX(${scaleX})`
      : `rotate(${e.angle}rad) scaleX(${scaleX})`;
    e.span.textContent = e.str + " "; // word break for copy; str keeps its exact scale

    boxes.push({
      x: e.left, y: e.top,
      w: e.targetWidth || e.fontHeight, h: e.fontHeight,
      text: normalizeText(e.str),
    });
  }

  return boxes;
}

// 2D affine matrix product, matching pdfjsLib.Util.transform
function matMul(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

// Normalize for text comparison: lowercase, strip everything but letters/digits
function normalizeText(s) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Append OCR word results from Tesseract to the text layer div.
 * Does NOT clear the layer — it runs after injectPDFTextLayer so both coexist.
 *
 * @param {HTMLDivElement} textLayerDiv
 * @param {Array<{text: string, bbox: {x0,y0,x1,y1}, variant?: boolean}>} words
 */
export function appendOCRTextLayer(textLayerDiv, words) {
  const entries = [];
  const frag = document.createDocumentFragment();

  // Pass 1: create a span per word, sized by its box height
  for (const word of words) {
    if (!word.text || !word.text.trim()) continue;

    const { x0, y0, x1, y1 } = word.bbox;
    const width  = x1 - x0;
    const height = y1 - y0;
    if (width <= 0 || height <= 0) continue;

    const span = document.createElement("span");
    span.textContent = word.text; // measured below; trailing space added after
    span.style.left     = `${x0}px`;
    span.style.top      = `${y0}px`;
    span.style.fontSize = `${Math.max(1, height)}px`;
    // Search-only correction variants are excluded from selection/copy via CSS
    if (word.variant) span.className = "variant";
    frag.appendChild(span);

    entries.push({ span, text: word.text, width });
  }

  textLayerDiv.appendChild(frag);

  // Pass 2 (read): measure natural widths in one layout pass
  for (const e of entries) e.measured = e.span.offsetWidth || 1;

  // Pass 3 (write): scale each word to exactly fill its OCR box width so the
  // invisible text overlays the visible word — selection and Find stay aligned.
  for (const e of entries) {
    const sx = e.width > 0 ? e.width / e.measured : 1;
    e.span.style.transform = `scaleX(${isFinite(sx) && sx > 0 ? sx : 1})`;
    e.span.textContent = e.text + " ";
  }
}

/**
 * Drop an OCR word only when it is a true duplicate of native PDF text — i.e. it
 * overlaps a PDF text box AND that box already contains the same word. This is
 * the case where OCR simply re-read text that PDF.js already provides.
 *
 * Words that overlap a native box but carry DIFFERENT text (e.g. text baked into
 * an image that happens to sit near native text) are kept, so image text stays
 * searchable even when identical-looking text exists elsewhere on the page.
 *
 * @param {Array<{text:string, bbox:{x0,y0,x1,y1}}>} words
 * @param {Array<{x:number,y:number,w:number,h:number,text:string}>} pdfBoxes
 */
export function filterOverlappingWords(words, pdfBoxes) {
  if (!pdfBoxes || pdfBoxes.length === 0) return words;

  return words.filter((w) => {
    const norm = normalizeText(w.text);
    if (!norm) return true; // punctuation/noise — keep, it's harmless

    const cx = (w.bbox.x0 + w.bbox.x1) / 2;
    const cy = (w.bbox.y0 + w.bbox.y1) / 2;

    // A duplicate = overlaps a native box whose text already includes this word
    const isNativeDuplicate = pdfBoxes.some((b) => {
      const overlaps = cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h;
      return overlaps && b.text.includes(norm);
    });

    return !isNativeDuplicate;
  });
}
