// "Find in Images" never replaces the user's view. Chrome's native PDF viewer
// stays the default for every PDF — same toolbar, same Ctrl+F, same everything.
// When the user presses Ctrl+Shift+F (or clicks the toolbar icon) on a scanned
// PDF, an offscreen document OCRs it and embeds an INVISIBLE text layer into a
// copy of the file (the classic "searchable scan" sandwich). The tab is then
// swapped to that copy — still in Chrome's native viewer — so the browser's own
// Ctrl+F finds text inside images. Triggering again restores the original URL.
//
// While processing, progress is shown as a badge on the toolbar icon; the tab
// keeps showing the original PDF the whole time.

const OFFSCREEN_URL = "offscreen/offscreen.html";

const LANGS = [
  ["eng", "English"],
  ["dan", "Dansk"],
  ["eng+dan", "English + Dansk"],
];

// http/https/file URL that points at a .pdf (optionally with query/hash).
function isPdfUrl(url) {
  return /^(https?|file):\/\/.*\.pdf(\?.*)?(#.*)?$/i.test(url);
}

async function getLang() {
  const { fii_ocr_lang } = await chrome.storage.local.get("fii_ocr_lang");
  return LANGS.some(([v]) => v === fii_ocr_lang) ? fii_ocr_lang : "eng";
}

// ── Swap bookkeeping ─────────────────────────────────────────────────────────
// tabId -> { original, blobUrl } for tabs currently showing a searchable copy.
// Kept in session storage so it survives service-worker suspends (blob URLs
// themselves live exactly as long as the offscreen document, i.e. the session).
async function getSwaps() {
  return (await chrome.storage.session.get("swaps")).swaps || {};
}
async function setSwaps(swaps) {
  await chrome.storage.session.set({ swaps });
}

// Tabs with a processing job in flight (badge shows progress). In-memory only:
// message traffic keeps the worker alive for the duration of a job.
const processing = new Set();

// ── Offscreen document lifecycle ─────────────────────────────────────────────
async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (contexts.length > 0) return;
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ["BLOBS"],
      justification:
        "Runs OCR on PDFs and keeps blob URLs alive for searchable copies shown in the native viewer",
    });
  } catch (err) {
    // A concurrent trigger may have created it between the check and the call.
    if (!String(err).includes("single offscreen")) throw err;
  }
}

// ── Badge helpers (per-tab progress on the toolbar icon) ─────────────────────
function badge(tabId, text, title) {
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  if (title) chrome.action.setTitle({ tabId, title }).catch(() => {});
}

function badgeFlash(tabId, text, title, ms = 4000) {
  badge(tabId, text, title);
  setTimeout(() => badge(tabId, "", "Search this PDF with OCR (Ctrl+Shift+F / ⌘⇧F)"), ms);
}

// ── Main toggle ──────────────────────────────────────────────────────────────
async function toggle(tab) {
  if (!tab || !tab.id || !tab.url) return;

  // Showing a searchable copy? Restore the original PDF.
  const swaps = await getSwaps();
  const entry = swaps[tab.id];
  if (entry && tab.url.split("#")[0] === entry.blobUrl) {
    delete swaps[tab.id];
    await setSwaps(swaps);
    chrome.runtime.sendMessage({ type: "fii-revoke", blobUrl: entry.blobUrl }).catch(() => {});
    chrome.tabs.update(tab.id, { url: entry.original });
    return;
  }

  if (processing.has(tab.id)) return; // job already running — badge shows progress
  if (!isPdfUrl(tab.url)) return;     // only act on PDF pages

  // Local files need the per-extension "Allow access to file URLs" setting.
  // Without it the offscreen fetch would fail — send the user to the toggle.
  if (tab.url.startsWith("file://")) {
    const allowed = await new Promise((res) => chrome.extension.isAllowedFileSchemeAccess(res));
    if (!allowed) {
      chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
      return;
    }
  }

  processing.add(tab.id);
  badge(tab.id, "…", "Making this PDF searchable…");
  try {
    await ensureOffscreen();
    chrome.runtime.sendMessage({
      type: "fii-process",
      tabId: tab.id,
      url: tab.url.split("#")[0],
      lang: await getLang(),
    });
  } catch (err) {
    processing.delete(tab.id);
    badgeFlash(tab.id, "!", `Find in Images: ${err.message || err}`);
  }
}

// ── Results from the offscreen document ──────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.type) return;

  if (msg.type === "fii-progress") {
    const pct = msg.total ? Math.round((msg.done / msg.total) * 100) : 0;
    badge(msg.tabId, `${pct}%`, `Making this PDF searchable… page ${msg.done}/${msg.total}`);
    return;
  }

  if (msg.type === "fii-error") {
    processing.delete(msg.tabId);
    badgeFlash(msg.tabId, "!", `Find in Images: ${msg.message}`);
    return;
  }

  if (msg.type === "fii-done") {
    processing.delete(msg.tabId);
    finishJob(msg).catch((err) => console.error("[FindInImages] finish failed:", err));
  }
});

async function finishJob({ tabId, url, blobUrl, words }) {
  if (!blobUrl) {
    // Every page already had real text — native Ctrl+F works as-is.
    badgeFlash(tabId, "✓", "This PDF is already searchable — just press Ctrl+F");
    return;
  }

  // Only swap if the tab still shows the same PDF (the user may have moved on).
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    tab = null;
  }
  if (!tab || !tab.url || tab.url.split("#")[0] !== url) {
    chrome.runtime.sendMessage({ type: "fii-revoke", blobUrl }).catch(() => {});
    return;
  }

  const swaps = await getSwaps();
  swaps[tabId] = { original: tab.url, blobUrl };
  await setSwaps(swaps);
  await chrome.tabs.update(tabId, { url: blobUrl });
  badgeFlash(tabId, "✓", `Searchable — ${words} words added. Press Ctrl+F to search, Ctrl+Shift+F to restore.`, 6000);
}

// ── Cleanup: revoke blobs when their tab goes away or navigates elsewhere ────
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const swaps = await getSwaps();
  if (!swaps[tabId]) return;
  chrome.runtime.sendMessage({ type: "fii-revoke", blobUrl: swaps[tabId].blobUrl }).catch(() => {});
  delete swaps[tabId];
  await setSwaps(swaps);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.url) return;
  const swaps = await getSwaps();
  const entry = swaps[tabId];
  if (entry && changeInfo.url.split("#")[0] !== entry.blobUrl) {
    chrome.runtime.sendMessage({ type: "fii-revoke", blobUrl: entry.blobUrl }).catch(() => {});
    delete swaps[tabId];
    await setSwaps(swaps);
  }
});

// ── Triggers ─────────────────────────────────────────────────────────────────
chrome.action.onClicked.addListener((tab) => toggle(tab));

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== "toggle-search") return;
  if (tab) {
    toggle(tab);
  } else {
    // Some Chrome versions don't pass the tab — fall back to the active one.
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs[0]) toggle(tabs[0]);
    });
  }
});

// ── OCR language: radio menu on the toolbar icon's right-click menu ──────────
chrome.runtime.onInstalled.addListener(async () => {
  const lang = await getLang();
  chrome.contextMenus.create({ id: "fii-lang", title: "OCR language", contexts: ["action"] });
  for (const [value, label] of LANGS) {
    chrome.contextMenus.create({
      id: `fii-lang-${value}`,
      parentId: "fii-lang",
      title: label,
      type: "radio",
      checked: value === lang,
      contexts: ["action"],
    });
  }
  chrome.action.setBadgeBackgroundColor({ color: "#1a73e8" });
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (typeof info.menuItemId === "string" && info.menuItemId.startsWith("fii-lang-")) {
    chrome.storage.local.set({ fii_ocr_lang: info.menuItemId.slice("fii-lang-".length) });
  }
});
