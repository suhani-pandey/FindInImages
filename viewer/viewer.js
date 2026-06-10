// Phase 2 will wire up PDF.js here.
// For now, read the PDF URL from the query string and show a status message.

const params = new URLSearchParams(window.location.search);
const pdfUrl = params.get("url") || params.get("file") || null;

const status = document.getElementById("status");

if (pdfUrl) {
  status.textContent = `PDF detected: ${decodeURIComponent(pdfUrl)}`;
} else {
  status.textContent = "No PDF loaded. Open a PDF in Chrome to use this viewer.";
}
