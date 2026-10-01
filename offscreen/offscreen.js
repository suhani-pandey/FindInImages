/**
 * Offscreen-document glue: receives processing requests from the service
 * worker, runs the searchable-PDF pipeline, and stores the result in Cache
 * Storage under the key the service worker chose. The service worker's fetch
 * handler serves it from there at the copy's chrome-extension:// URL.
 */

import { processPdf } from "./processor.js";
import { pruneCache } from "./cache.js";
import { releaseWorkers } from "./ocr.js";

// Tesseract workers hold a language model each (tens of MB apiece), so they
// are shut down once no job has arrived for this long.
const IDLE_RELEASE_MS = 60_000;

// Jobs run one PDF at a time; pages within a PDF are already parallelized
// across the OCR workers, so more concurrency would just thrash memory.
let queue = Promise.resolve();
let pendingJobs = 0;
let idleTimer = null;

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "fii-process") {
    pendingJobs++;
    clearTimeout(idleTimer);
    queue = queue
      .then(() => handleJob(msg))
      .catch(() => {})
      .then(() => {
        if (--pendingJobs === 0) idleTimer = setTimeout(releaseWorkers, IDLE_RELEASE_MS);
      });
  }
});

async function handleJob({ tabId, url, lang, copyUrl, cache, cacheKey }) {
  const send = (m) => chrome.runtime.sendMessage(m).catch(() => {});
  try {
    const { bytes, words } = await processPdf(url, lang, (done, total) =>
      send({ type: "fii-progress", tabId, done, total })
    );
    if (!bytes) {
      // Every page already had a text layer — nothing to add, don't swap.
      send({ type: "fii-done", tabId, url, copyUrl: null, words: 0 });
      return;
    }
    const response = new Response(bytes, { headers: { "content-type": "application/pdf" } });
    await (await caches.open(cache)).put(cacheKey, response);
    send({ type: "fii-done", tabId, url, copyUrl, words });
  } catch (err) {
    console.error("[FindInImages] processing failed:", err);
    send({ type: "fii-error", tabId, url, message: String((err && err.message) || err) });
  } finally {
    await pruneCache(); // keep the OCR cache bounded
  }
}
