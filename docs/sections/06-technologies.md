## 6 Technologies & Integration

Every part of the extension runs on the client. Each technology has one job; the value is in how they are coordinated.

| Technology | Role | Where |
| --- | --- | --- |
| Chrome Extension (Manifest V3) | Permissions (`offscreen`, `storage`, `contextMenus`, host access), CSP with `wasm-unsafe-eval`, shortcut, Chrome ≥ 116 | `manifest.json` |
| Service worker + `chrome.action` / `chrome.commands` | Trigger, per-tab badge progress and errors, tab switch, `fetch` handler that serves copies, cleanup | `service-worker.js` |
| Offscreen document (`chrome.offscreen`) | Hidden page with DOM, canvas and Web Workers that hosts the pipeline | `offscreen/offscreen.js` |
| PDF.js | Per-page text and image detection; rendering pages for OCR; mapping pixels back to PDF space | `processor.js`, `ocr.js` |
| Canvas 2D | OCR raster target and pixel-level preprocessing | `ocr.js` |
| Tesseract.js (WASM) + Web Workers | OCR with word boxes on a worker pool; English and Danish data bundled | `ocr.js` |
| pdf-lib | Writes the invisible text into the copy and saves it | `embed.js`, `processor.js` |
| Web Crypto | SHA-256 of the file as its identity | `cache.js` |
| IndexedDB | OCR results per page, least-recently-used pruning | `cache.js` |
| Cache Storage | Searchable copies, served at extension URLs | `offscreen.js`, `service-worker.js` |
| `chrome.storage`, `chrome.contextMenus` | OCR language; which tab shows which copy; the language menu | `service-worker.js` |
| Chrome's native PDF viewer | All display, search, highlighting, selection, printing | Chrome |

### 6.1 How the pieces talk

- **Service worker ↔ offscreen document — small messages only.** In: `fii-process` with the PDF URL, language, and the copy URL and cache key the service worker chose. Out: `fii-progress` (page counts, shown as a badge percentage), then `fii-done` with the copy URL or `fii-error` with a readable message.
- **Bytes travel through storage, not messages.** The offscreen document puts the finished PDF into Cache Storage; the service worker's `fetch` handler reads it from there when Chrome requests the copy URL. Both can reach it because they share the extension's origin.
- **Cache Storage keys.** Cache Storage only accepts http(s) request keys, so a copy at `chrome-extension://<id>/searchable/…` is stored under `https://find-in-images.invalid/searchable/…` (same path, placeholder origin).
- **No content scripts, no web-accessible resources.** The extension never runs code in web pages; navigation to the copy is done by the extension itself (`chrome.tabs.update`).

### 6.2 Vendored libraries

All libraries are bundled under `lib/` so nothing is fetched at runtime. Tesseract.js normally picks one of six WebAssembly builds at runtime. Its relaxed-SIMD build crashes on some Chrome and Apple Silicon combinations, so `lib/tesseract/worker.min.js` is patched to never choose it. Only the two builds that can actually load (SIMD + LSTM, and plain LSTM as a fallback) are shipped, which keeps the package at about 8.5 MB.
