/**
 * Offscreen-document glue: receives processing requests from the service
 * worker, runs the searchable-PDF pipeline, and hands back a blob URL.
 *
 * This document also OWNS the blob URLs — a blob URL dies with the document
 * that created it, and MV3 service workers can't create them at all, so this
 * page stays alive (reason: BLOBS) while tabs display searchable copies.
 */

import { processPdf } from "./processor.js";

// Jobs run one PDF at a time; pages within a PDF are already parallelized
// across the OCR workers, so more concurrency would just thrash memory.
let queue = Promise.resolve();

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "fii-process") {
    queue = queue.then(() => handleJob(msg)).catch(() => {});
  } else if (msg && msg.type === "fii-revoke" && msg.blobUrl) {
    URL.revokeObjectURL(msg.blobUrl); // searchable copy no longer shown anywhere
  }
});

async function handleJob({ tabId, url, lang }) {
  const send = (m) => chrome.runtime.sendMessage(m).catch(() => {});
  try {
    const { bytes, words } = await processPdf(url, lang, (done, total) =>
      send({ type: "fii-progress", tabId, done, total })
    );
    if (!bytes) {
      // Every page already had a text layer — nothing to add, don't swap.
      send({ type: "fii-done", tabId, url, blobUrl: null, words: 0 });
      return;
    }
    const blobUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    send({ type: "fii-done", tabId, url, blobUrl, words });
  } catch (err) {
    console.error("[FindInImages] processing failed:", err);
    send({ type: "fii-error", tabId, url, message: String((err && err.message) || err) });
  }
}
