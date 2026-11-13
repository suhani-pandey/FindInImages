/**
 * OCR post-processing to improve native Ctrl+F hit-rate.
 *
 * Because we rely on the browser's built-in Find (exact substring matching), we
 * can't fuzzy-match at search time. Instead we clean up OCR output and, for
 * likely-misread words, emit an extra corrected variant at the SAME position.
 * Both the raw and corrected spans get injected, so the user finds the word
 * whether they type the real spelling or the OCR'd one.
 *
 * Input  words: [{ text, bbox, confidence, line }]   (confidence 0..100, optional)
 * Output words: [{ text, bbox, line }]               (filtered, trimmed, +variants)
 */

// Minimum OCR confidence to keep a word. Findability is the priority here, so we
// keep almost everything (a low floor only drops near-zero garbage). Raising this
// would trade recall (missing faint/small image text) for fewer false matches.
const DEFAULT_MIN_CONFIDENCE = 1;

// Most-common digit→letter OCR confusions. Applied only to word-like tokens so
// real numbers (years, codes) are left alone.
const DIGIT_TO_LETTER = {
  "0": "o",
  "1": "l",
  "5": "s",
  "6": "b",
  "8": "b",
  "9": "g",
  "2": "z",
};

export function postProcessWords(words, { minConfidence = DEFAULT_MIN_CONFIDENCE } = {}) {
  const out = [];

  for (const w of words) {
    // 1. Drop low-confidence noise
    if (typeof w.confidence === "number" && w.confidence < minConfidence) continue;

    // 2. Trim leading/trailing non-alphanumeric junk (after restoring CO₂ & co,
    //    whose misread subscript would otherwise be trimmed away)
    const text = trimNoise(fixSubscripts(w.text));
    if (!text) continue;

    // 3. Keep the raw (trimmed) word — this is the selectable/copyable one
    out.push({ text, bbox: w.bbox, line: w.line });

    // 4. Add a digit→letter corrected variant for likely-misread words.
    //    Marked variant:true so it's search-only (not selectable/copyable).
    const variant = correctionVariant(text);
    if (variant && variant !== text) {
      out.push({ text: variant, bbox: w.bbox, line: w.line, variant: true });
    }
  }

  return out;
}

// Tesseract reads the small subscript ₂ of CO₂ and SO₂ as a colon or a "z"
// ("CO:", "CO:z", "CO:'s", "SOz/year") or the O as a zero ("C02"), at any
// resolution, so a search for "CO2" — everywhere in climate and chemistry
// material — found nothing. Restore the plain-text spelling of these two.
const SUBSCRIPT_FORMULA = /^([CS])[O0](?::[2₂zZ]?|[2₂zZ])(['’]s|\/\p{L}+)?[^\p{L}\p{N}]*$/u;

function fixSubscripts(s) {
  const m = s.match(SUBSCRIPT_FORMULA);
  return m ? `${m[1]}O2${m[2] || ""}` : s;
}

// Strip characters that aren't letters/digits from both ends of the token.
// Unicode-aware so Danish words keep their æ/ø/å ("på" must not become "p").
function trimNoise(s) {
  return s.replace(/^[^\p{L}\p{N}]+/u, "").replace(/[^\p{L}\p{N}]+$/u, "");
}

/**
 * For a word whose digits all sit BETWEEN letters, assume the digits are
 * misread letters and map them back (e.g. "he11o"→"hello", "ca5h"→"cash").
 * Digits at either end of a word are usually real — "CO2", "A4", "MP3",
 * "COVID19", "2nd" — and must not become "COz" (the corrected form is the one
 * embedded), so they're left alone. Returns null when no correction applies.
 */
function correctionVariant(text) {
  if (!/^\p{L}+(?:[0-9]+\p{L}+)+$/u.test(text)) return null;

  // Skip tokens that are mostly digits — likely a genuine number/code
  const digitCount = (text.match(/[0-9]/g) || []).length;
  if (digitCount / text.length > 0.5) return null;

  return text.replace(/[0-9]/g, (d) => DIGIT_TO_LETTER[d] ?? d);
}
