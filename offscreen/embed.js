/**
 * Invisible-text embedding: writes OCR words into a PDF page as real PDF text
 * with rendering mode 3 (invisible) — the standard "searchable scan" sandwich
 * technique used by scanners and ocrmypdf.
 *
 * Because the text genuinely lives in the PDF, Chrome's NATIVE viewer finds,
 * highlights, and copies it with its own Ctrl+F — no custom UI anywhere.
 *
 * Text is written one OCR line at a time. Every word sits on the line's
 * baseline at the line's font size, with a Tz horizontal squeeze so its advance
 * width matches the visible word — that makes the native find highlight cover
 * it. Between words a real space character is written, squeezed or stretched
 * to fill the gap, so PDF engines see "Not now" rather than guessing whether
 * two neighbouring words belong together (Chrome's often guessed "Notnow").
 *
 * `PDFLib` is passed in (UMD global in the offscreen document, require() in
 * node tests) so this module stays environment-free.
 */

/**
 * @param {object} PDFLib   the pdf-lib module/global
 * @param {object} page     pdf-lib PDFPage
 * @param {object} font     pdf-lib PDFFont (embedded standard font)
 * @param {object} fontKey  PDFName from page.node.newFontDictionary(...)
 * @param {Array<{size:number, words:Array<{text:string, x:number, y:number, ex:number, ey:number, w:number, angle:number}>}>} lines
 *        PDF user space: (x,y)→(ex,ey) = the word's baseline, w = its length,
 *        angle = baseline angle in radians (0 for upright pages)
 * @returns {number} number of words embedded
 */
export function embedLines(PDFLib, page, font, fontKey, lines) {
  const ops = [];
  let count = 0;

  for (const line of lines) {
    const size = line.size;
    // Words the font can encode (standard fonts use WinAnsi — skip glyphs it
    // can't represent rather than failing the whole page).
    const words = [];
    for (const wd of line.words) {
      const text = sanitize(wd.text);
      if (!text || !(wd.w > 0)) continue;
      try {
        const natural = font.widthOfTextAtSize(text, size);
        if (natural > 0) words.push({ ...wd, encoded: font.encodeText(text), natural });
      } catch {
        // unencodable character — skip the word
      }
    }
    if (!words.length) continue;

    const space = font.encodeText(" ");
    const spaceWidth = font.widthOfTextAtSize(" ", size);

    ops.push(
      PDFLib.beginText(),
      PDFLib.setTextRenderingMode(PDFLib.TextRenderingMode.Invisible),
      PDFLib.setFontAndSize(fontKey, size),
    );
    words.forEach((wd, i) => {
      const cos = Math.cos(wd.angle || 0);
      const sin = Math.sin(wd.angle || 0);
      ops.push(
        PDFLib.setCharacterSqueeze(squeeze(wd.w, wd.natural)),
        PDFLib.setTextMatrix(cos, sin, -sin, cos, wd.x, wd.y),
        PDFLib.showText(wd.encoded),
      );
      const next = words[i + 1];
      if (next) {
        // Fill the gap from this word's end to the next word's start. Overlap
        // (gap ≤ 0) still gets a hair-thin space so the words stay separate.
        const gap = Math.max(0, (next.x - wd.ex) * cos + (next.y - wd.ey) * sin);
        ops.push(PDFLib.setCharacterSqueeze(squeeze(gap, spaceWidth)), PDFLib.showText(space));
      }
      count++;
    });
    ops.push(PDFLib.endText());
  }

  if (count) {
    // Wrapped in q/Q so the text state can't leak into the page's own content
    // (we append after it, but viewers replay the full stream on every draw).
    page.pushOperators(PDFLib.pushGraphicsState(), ...ops, PDFLib.popGraphicsState());
  }
  return count;
}

// Tz takes a percentage; clamp to sane bounds for degenerate boxes.
function squeeze(target, natural) {
  return Math.max(1, Math.min(1000, (target / natural) * 100));
}

// Strip control characters; anything WinAnsi can't hold is handled by the
// encode try/catch above.
function sanitize(s) {
  return (s || "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
}
