// Runs in the context of every page.
// For now, just verifies the extension is active.
// Phase 2+ will handle image-based content on regular web pages.

(function () {
  const isPDF = document.contentType === "application/pdf";
  if (isPDF) {
    // PDFs are intercepted by declarativeNetRequest and sent to the viewer.
    // This content script won't run inside the viewer iframe.
    return;
  }
})();
