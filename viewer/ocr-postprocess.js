/**
 * OCR post-processing to improve native Ctrl+F hit-rate.
 *
 * Because we rely on the browser's built-in Find (exact substring matching), we
 * can't fuzzy-match at search time. Instead we clean up OCR output and, for
 * likely-misread words, emit an extra corrected variant at the SAME position.
 * Both the raw and corrected spans get injected, so the user finds the word
 * whether they type the real spelling or the OCR'd one.
 *
 * Input  words: [{ text, bbox, confidence }]   (confidence 0..100, optional)
 * Output words: [{ text, bbox }]               (filtered, trimmed, +variants)
 */

// Words below this OCR confidence are usually noise (stray marks misread as
// characters). Dropping them reduces false Ctrl+F matches. Tunable.
const DEFAULT_MIN_CONFIDENCE = 30;

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

    // 2. Trim leading/trailing non-alphanumeric junk
    const text = trimNoise(w.text);
    if (!text) continue;

    // 3. Keep the raw (trimmed) word — this is the selectable/copyable one
    out.push({ text, bbox: w.bbox });

    // 4. Add a digit→letter corrected variant for likely-misread words.
    //    Marked variant:true so it's search-only (not selectable/copyable).
    const variant = correctionVariant(text);
    if (variant && variant !== text) {
      out.push({ text: variant, bbox: w.bbox, variant: true });
    }
  }

  return out;
}

// Strip characters that aren't letters/digits from both ends of the token
function trimNoise(s) {
  return s.replace(/^[^a-zA-Z0-9]+/, "").replace(/[^a-zA-Z0-9]+$/, "");
}

/**
 * For a token that contains both letters and digits and is *mostly* letters,
 * assume the digits are misread letters and map them back (e.g. "he11o"→"hello",
 * "ca5h"→"cash"). Returns null when no correction applies.
 */
function correctionVariant(text) {
  const hasLetter = /[a-zA-Z]/.test(text);
  const hasDigit  = /[0-9]/.test(text);
  if (!hasLetter || !hasDigit) return null;

  // Skip tokens that are mostly digits — likely a genuine number/code
  const digitCount = (text.match(/[0-9]/g) || []).length;
  if (digitCount / text.length > 0.5) return null;

  return text.replace(/[0-9]/g, (d) => DIGIT_TO_LETTER[d] ?? d);
}
