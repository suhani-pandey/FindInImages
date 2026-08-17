/**
 * Invisible-text embedding: writes OCR words into a PDF page as real PDF text
 * with rendering mode 3 (invisible) — the standard "searchable scan" sandwich
 * technique used by scanners and ocrmypdf.
 *
 * Because the text genuinely lives in the PDF, Chrome's NATIVE viewer finds,
 * highlights, and copies it with its own Ctrl+F — no custom UI anywhere.
 *
 * Each word is drawn at its OCR baseline with the font size matching the box
 * height and a Tz horizontal squeeze so the advance width matches the box
 * width — that makes the native find highlight cover the visible word.
 *
 * `PDFLib` is passed in (UMD global in the offscreen document, require() in
 * node tests) so this module stays environment-free.
 */

/**
 * @param {object} PDFLib   the pdf-lib module/global
 * @param {object} page     pdf-lib PDFPage
 * @param {object} font     pdf-lib PDFFont (embedded standard font)
 * @param {object} fontKey  PDFName from page.node.newFontDictionary(...)
 * @param {Array<{text:string, x:number, y:number, w:number, h:number, angle:number}>} words
 *        PDF user-space: (x,y) = baseline start, w = target advance width,
 *        h = font size, angle = baseline angle in radians (0 for upright pages)
 * @returns {number} number of words embedded
 */
export function embedWords(PDFLib, page, font, fontKey, words) {
  const ops = [];
  let count = 0;

  for (const wd of words) {
    const text = sanitize(wd.text);
    if (!text || !(wd.w > 0) || !(wd.h > 0)) continue;

    // Standard fonts use WinAnsi encoding — skip glyphs it can't represent
    // rather than failing the whole page.
    let encoded, natural;
    try {
      encoded = font.encodeText(text);
      natural = font.widthOfTextAtSize(text, wd.h);
    } catch {
      continue;
    }
    if (!natural || natural <= 0) continue;

    // Tz takes a percentage; clamp to sane bounds for degenerate boxes.
    const squeeze = Math.max(1, Math.min(1000, (wd.w / natural) * 100));
    const cos = Math.cos(wd.angle || 0);
    const sin = Math.sin(wd.angle || 0);

    ops.push(
      PDFLib.beginText(),
      PDFLib.setTextRenderingMode(PDFLib.TextRenderingMode.Invisible),
      PDFLib.setFontAndSize(fontKey, wd.h),
      PDFLib.setCharacterSqueeze(squeeze),
      PDFLib.setTextMatrix(cos, sin, -sin, cos, wd.x, wd.y),
      PDFLib.showText(encoded),
      PDFLib.endText(),
    );
    count++;
  }

  if (count) {
    // Wrapped in q/Q so the text state can't leak into the page's own content
    // (we append after it, but viewers replay the full stream on every draw).
    page.pushOperators(PDFLib.pushGraphicsState(), ...ops, PDFLib.popGraphicsState());
  }
  return count;
}

// Strip control characters; collapse anything WinAnsi can't hold is handled by
// the encode try/catch above.
function sanitize(s) {
  return (s || "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
}
