import * as pdfjsLib from "../lib/pdfjs/pdf.min.mjs";

// Point PDF.js at our local worker so MV3 CSP is satisfied
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("lib/pdfjs/pdf.worker.min.mjs");

const SCALE = 1.5; // render at 1.5× for sharpness

const status   = document.getElementById("status");
const container = document.getElementById("viewer-container");

// ── Resolve the PDF URL ──────────────────────────────────────────────────────
// Chrome redirects  https://example.com/doc.pdf  →  viewer.html?url=<encoded>
// The declarativeNetRequest redirect preserves the original URL in ?url=
const params = new URLSearchParams(window.location.search);
const pdfUrl = params.get("url") || params.get("file");

if (!pdfUrl) {
  status.textContent = "No PDF loaded. Open a .pdf link in Chrome to use this viewer.";
} else {
  loadPDF(decodeURIComponent(pdfUrl));
}

// ── Main loader ──────────────────────────────────────────────────────────────
async function loadPDF(url) {
  status.textContent = "Loading PDF…";

  let pdf;
  try {
    const loadingTask = pdfjsLib.getDocument(url);
    pdf = await loadingTask.promise;
  } catch (err) {
    status.textContent = `Failed to load PDF: ${err.message}`;
    console.error("[FindInImages] PDF load error:", err);
    return;
  }

  const totalPages = pdf.numPages;
  status.textContent = `Rendering page 1 of ${totalPages}…`;

  // Render pages one at a time so the first page appears fast
  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    await renderPage(pdf, pageNum);
    status.textContent =
      pageNum < totalPages
        ? `Rendering page ${pageNum + 1} of ${totalPages}…`
        : `Done — ${totalPages} page${totalPages > 1 ? "s" : ""} loaded.`;
  }
}

// ── Page renderer ────────────────────────────────────────────────────────────
async function renderPage(pdf, pageNum) {
  const page     = await pdf.getPage(pageNum);
  const viewport = page.getViewport({ scale: SCALE });

  // Wrapper holds both the canvas and the (future) text layer
  const wrapper = document.createElement("div");
  wrapper.className = "page-wrapper";
  wrapper.style.width  = `${viewport.width}px`;
  wrapper.style.height = `${viewport.height}px`;

  const canvas  = document.createElement("canvas");
  const ctx     = canvas.getContext("2d");
  canvas.width  = viewport.width;
  canvas.height = viewport.height;
  wrapper.appendChild(canvas);

  // Text layer div — Phase 3 will populate this with OCR/PDF text spans
  const textLayer = document.createElement("div");
  textLayer.className = "text-layer";
  wrapper.appendChild(textLayer);

  container.appendChild(wrapper);

  await page.render({ canvasContext: ctx, viewport }).promise;

  // Attach metadata for Phase 3 (text detection + OCR)
  wrapper.dataset.pageNum  = pageNum;
  wrapper.dataset.viewport = JSON.stringify({
    width:  viewport.width,
    height: viewport.height,
    scale:  SCALE,
  });
}
