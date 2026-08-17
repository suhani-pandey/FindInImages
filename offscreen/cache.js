/**
 * IndexedDB cache for OCR results.
 *
 * OCR is CPU-heavy, so we store each page's recognized words and reuse them on
 * subsequent loads. Coordinates are stored NORMALIZED (0..1 fractions of the
 * page dimensions) so the cache is independent of the render scale — a page
 * OCR'd at one zoom level still positions correctly at any other.
 *
 * Record shape (keyed by `${docId}::${pageNum}`):
 *   { words: [{ text, bbox: {x0,y0,x1,y1} }],  // bbox values in 0..1
 *     ts: <epoch ms>, v: <format version> }
 */

const DB_NAME    = "find-in-images";
const DB_VERSION = 1;
const STORE      = "ocr-pages";
// Bump when the OCR pipeline changes so stale results are re-computed.
// v2: high-resolution OCR canvas + keep-low-confidence words.
// v3: sparse-text segmentation (tables) + 3000px render + contrast preprocessing.
// v4: stronger preprocessing — percentile contrast stretch + unsharp mask.
const FORMAT_VER = 4;

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;

  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });

  return _dbPromise;
}

const keyFor = (docId, pageNum) => `${docId}::${pageNum}`;

/**
 * Return cached normalized words for a page, or null on miss/error.
 */
export async function getCachedPage(docId, pageNum) {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(keyFor(docId, pageNum));
      req.onsuccess = () => {
        const rec = req.result;
        resolve(rec && rec.v === FORMAT_VER ? rec.words : null);
      };
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn("[FindInImages] cache read failed:", err);
    return null;
  }
}

/**
 * Store normalized words for a page. Empty arrays are cached too, so pages with
 * no detectable image text aren't re-OCR'd on every load.
 */
export async function setCachedPage(docId, pageNum, words) {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put({ words, ts: Date.now(), v: FORMAT_VER }, keyFor(docId, pageNum));
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(tx.error);
    });
  } catch (err) {
    console.warn("[FindInImages] cache write failed:", err);
  }
}

/**
 * Wipe the entire OCR cache (all documents).
 */
export async function clearCache() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}
