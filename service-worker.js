// "Find in Images" runs on demand. The native Chrome PDF viewer stays the default
// for every PDF, so users keep its toolbar, thumbnails, rotate, print, download,
// Google Lens, and right-click menu. To make a PDF searchable, the user presses
// the keyboard shortcut (Ctrl+Shift+F / Cmd+Shift+F) or clicks the toolbar icon;
// that opens THAT PDF in our custom OCR viewer. Triggering it again while in our
// viewer returns the tab to the native viewer (a toggle).

const VIEWER_PATH = "viewer/viewer.html";

function viewerUrlFor(pdfUrl) {
  return `${chrome.runtime.getURL(VIEWER_PATH)}?url=${encodeURIComponent(pdfUrl)}`;
}

// http/https/file URL that points at a .pdf (optionally with query/hash).
function isPdfUrl(url) {
  return /^(https?|file):\/\/.*\.pdf(\?.*)?(#.*)?$/i.test(url);
}

// If the tab is already showing OUR viewer, return the original PDF URL it wraps.
function originalUrlFromViewer(url) {
  if (!url.startsWith(chrome.runtime.getURL(VIEWER_PATH))) return null;
  try {
    return new URL(url).searchParams.get("url");
  } catch {
    return null;
  }
}

function toggleViewer(tab) {
  if (!tab || !tab.id || !tab.url) return;

  // Toggle back: if we're in our viewer, return to the native PDF viewer.
  const original = originalUrlFromViewer(tab.url);
  if (original) {
    chrome.tabs.update(tab.id, { url: original });
    return;
  }

  // Not a PDF: do nothing — the trigger only acts on PDF pages.
  if (!isPdfUrl(tab.url)) return;

  // Local files need the per-extension "Allow access to file URLs" setting.
  // If it's off, opening our viewer would just fail with a load error — instead
  // send the user straight to this extension's details page where the toggle is.
  if (tab.url.startsWith("file://")) {
    chrome.extension.isAllowedFileSchemeAccess((allowed) => {
      if (allowed) {
        chrome.tabs.update(tab.id, { url: viewerUrlFor(tab.url) });
      } else {
        chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
      }
    });
    return;
  }

  // Remote PDF — open directly in our OCR viewer.
  chrome.tabs.update(tab.id, { url: viewerUrlFor(tab.url) });
}

// Toolbar icon click — discoverable trigger.
chrome.action.onClicked.addListener((tab) => toggleViewer(tab));

// Keyboard shortcut (Ctrl+Shift+F / Cmd+Shift+F) — fast trigger. Works even while
// Chrome's native PDF viewer has focus, since commands are browser-global.
chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== "toggle-search") return;
  if (tab) {
    toggleViewer(tab);
  } else {
    // Some Chrome versions don't pass the tab — fall back to the active one.
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs[0]) toggleViewer(tabs[0]);
    });
  }
});
