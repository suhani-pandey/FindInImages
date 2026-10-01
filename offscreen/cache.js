/**
 * IndexedDB cache for OCR results.
 *
 * OCR is CPU-heavy, so we store each page's recognized words and reuse them on
 * subsequent loads. Coordinates are stored NORMALIZED (0..1 fractions of the
 * page dimensions) so the cache is independent of the render scale — a page
 * OCR'd at one zoom level still positions correctly at any other.
 *
 * Documents are identified by a hash of their BYTES, not their URL: the same
 * URL can serve a different file later (an edited local file, a "latest.pdf"
 * link), and stale word positions must never be embedded into the new file.
 *
 * Record shape (keyed by `${docId}::${pageNum}`):
 *   { words: [{ text, bbox: {x0,y0,x1,y1} }],  // bbox values in 0..1
 *     ts: <epoch ms, last use>, v: <format version> }
 */

const DB_NAME    = "find-in-images";
// v2: keys are content hashes (v1 keys were URLs, so v1 records are dropped)
//     and records carry a `ts` index for least-recently-used pruning.
const DB_VERSION = 2;
const STORE      = "ocr-pages";
// Bump when the OCR pipeline changes so stale results are re-computed.
// v2: high-resolution OCR canvas + keep-low-confidence words.
// v3: sparse-text segmentation (tables) + 3000px render + contrast preprocessing.
// v4: stronger preprocessing — percentile contrast stretch + unsharp mask.
// v5: contrast-stretch gain capped (sparse pages were amplified into noise).
// v6: word trimming keeps non-ASCII letters (Danish "på" was stored as "p").
const FORMAT_VER = 6;

// A page record is roughly 10–40 KB, so this caps the cache at tens of MB.
const MAX_PAGES = 2000;

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;

  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (e.oldVersion < 2 && db.objectStoreNames.contains(STORE)) {
        db.deleteObjectStore(STORE); // URL-keyed v1 records can't be reused
      }
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE).createIndex("ts", "ts");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });

  return _dbPromise;
}

const keyFor = (docId, pageNum) => `${docId}::${pageNum}`;

/**
 * Hex SHA-256 of a document's bytes — the stable document id for the cache.
 */
export async function hashBytes(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Return cached normalized words for a page, or null on miss/error. A hit
 * refreshes the record's timestamp so frequently used documents survive pruning.
 */
export async function getCachedPage(docId, pageNum) {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const store = db.transaction(STORE, "readwrite").objectStore(STORE);
      const key = keyFor(docId, pageNum);
      const req = store.get(key);
      req.onsuccess = () => {
        const rec = req.result;
        if (!rec || rec.v !== FORMAT_VER) return resolve(null);
        store.put({ ...rec, ts: Date.now() }, key);
        resolve(rec.words);
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
 * Drop the least-recently-used pages until at most `max` remain.
 */
export async function pruneCache(max = MAX_PAGES) {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const countReq = store.count();
      countReq.onsuccess = () => {
        let excess = countReq.result - max;
        if (excess <= 0) return;
        store.index("ts").openCursor().onsuccess = (e) => {
          const cursor = e.target.result;
          if (!cursor || excess-- <= 0) return;
          cursor.delete();
          cursor.continue();
        };
      };
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(tx.error);
    });
  } catch (err) {
    console.warn("[FindInImages] cache prune failed:", err);
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
