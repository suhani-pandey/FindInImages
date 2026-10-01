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

// ── Searchable copies ────────────────────────────────────────────────────────
// A copy is shown at chrome-extension://<id>/searchable/<token>/<file name>
// ?src=<original URL>. The offscreen document stores its bytes in Cache Storage
// and the fetch handler below serves them, so Chrome opens the copy in its
// native PDF viewer under the original's file name (the tab title is unchanged).
// blob: URLs can't be used: Chrome refuses to navigate an existing web tab to
// an extension-owned blob: URL (blob URLs are partitioned by site).
const COPY_CACHE = "fii-copies";
const COPY_PATH = "searchable/";
// Cache Storage only accepts http(s) request keys, so copies are stored under
// this placeholder origin with the copy URL's path.
const COPY_KEY_ORIGIN = "https://find-in-images.invalid";

const copyKey = (copyUrl) => COPY_KEY_ORIGIN + new URL(copyUrl).pathname;
const isCopyUrl = (url) => url.startsWith(chrome.runtime.getURL(COPY_PATH));

function newCopyUrl(original) {
  const name = encodeURIComponent(fileNameFromUrl(original));
  return chrome.runtime.getURL(`${COPY_PATH}${crypto.randomUUID()}/${name}`) +
    `?src=${encodeURIComponent(original)}`;
}

function originalOf(copyUrl) {
  try {
    return new URL(copyUrl).searchParams.get("src");
  } catch {
    return null;
  }
}

// The name Chrome's viewer shows for a URL: its last path segment, decoded.
function fileNameFromUrl(url) {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop();
    return (last && decodeURIComponent(last)) || u.hostname || "document.pdf";
  } catch {
    return "document.pdf";
  }
}

async function deleteCopy(copyUrl) {
  try {
    await (await caches.open(COPY_CACHE)).delete(copyKey(copyUrl));
  } catch (err) {
    console.warn("[FindInImages] couldn't delete copy:", err);
  }
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(`/${COPY_PATH}`)) return;
  event.respondWith(serveCopy(url));
});

async function serveCopy(url) {
  const hit = await (await caches.open(COPY_CACHE)).match(COPY_KEY_ORIGIN + url.pathname);
  if (hit) return hit;
  // The copy is gone (browser restarted, or the tab came back from history
  // after cleanup): fall back to the original PDF rather than an error page.
  const src = url.searchParams.get("src");
  if (src && isFetchableUrl(src)) return Response.redirect(src, 302);
  return new Response("This searchable copy is no longer available.", { status: 404 });
}

// Copies only live for one browser session.
chrome.runtime.onStartup.addListener(() => caches.delete(COPY_CACHE));

const LANGS = [
  ["eng", "English"],
  ["dan", "Dansk"],
  ["eng+dan", "English + Dansk"],
];

// Any http/https/file URL. Many PDFs are served without ".pdf" in the link
// (arxiv.org/pdf/…, download.php?id=…), so the offscreen document checks the
// downloaded bytes instead and reports pages that aren't PDFs.
function isFetchableUrl(url) {
  return /^(https?|file):\/\//i.test(url);
}

async function getLang() {
  const { fii_ocr_lang } = await chrome.storage.local.get("fii_ocr_lang");
  return LANGS.some(([v]) => v === fii_ocr_lang) ? fii_ocr_lang : "eng";
}

// ── Swap bookkeeping ─────────────────────────────────────────────────────────
// tabId -> copy URL for tabs currently showing a searchable copy, so the copy
// can be deleted when its tab closes or navigates away. Kept in session storage
// so it survives service-worker suspends.
async function getSwaps() {
  return (await chrome.storage.session.get("swaps")).swaps || {};
}
async function setSwaps(swaps) {
  await chrome.storage.session.set({ swaps });
}
async function dropSwap(tabId) {
  const swaps = await getSwaps();
  const copyUrl = swaps[tabId];
  if (!copyUrl) return;
  delete swaps[tabId];
  await setSwaps(swaps);
  await deleteCopy(copyUrl);
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
      reasons: ["WORKERS"],
      justification: "Renders PDF pages and runs OCR in web workers to build a searchable copy",
    });
  } catch (err) {
    // A concurrent trigger may have created it between the check and the call.
    if (!String(err).includes("single offscreen")) throw err;
  }
}

// ── Badge helpers (per-tab progress on the toolbar icon) ─────────────────────
const IDLE_TITLE = "Search this PDF with OCR (Ctrl+Shift+F)";
const BLUE = "#1a73e8";
const RED = "#d93025";

// tabId -> generation, so a flash's delayed reset can't wipe a newer badge
// (e.g. the user retries right after an error and progress is showing).
const badgeGen = new Map();

function badge(tabId, text, title, color = BLUE) {
  badgeGen.set(tabId, (badgeGen.get(tabId) || 0) + 1);
  chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  if (title) chrome.action.setTitle({ tabId, title }).catch(() => {});
}

function badgeFlash(tabId, text, title, ms = 4000, color = BLUE) {
  badge(tabId, text, title, color);
  const gen = badgeGen.get(tabId);
  setTimeout(() => {
    if (badgeGen.get(tabId) === gen) badge(tabId, "", IDLE_TITLE);
  }, ms);
}

// Errors stay up longer and in red: the tooltip is the only place they're
// explained, so the user needs time to notice and hover.
function badgeError(tabId, message) {
  badgeFlash(tabId, "!", `Find in Images: ${message}`, 15000, RED);
}

// ── Main toggle ──────────────────────────────────────────────────────────────
async function toggle(tab) {
  if (!tab || !tab.id) return;
  if (!tab.url) {
    // No URL access: a local file without "Allow access to file URLs", or a
    // page the extension can't read at all.
    badgeError(tab.id, "can't read this tab. For local files, turn on \"Allow access to file URLs\" for Find in Images in chrome://extensions");
    return;
  }

  // Showing a searchable copy? Restore the original PDF.
  if (isCopyUrl(tab.url)) {
    const original = originalOf(tab.url);
    await dropSwap(tab.id);
    await deleteCopy(tab.url);
    if (original) chrome.tabs.update(tab.id, { url: original });
    return;
  }

  if (processing.has(tab.id)) return; // job already running — badge shows progress
  if (!isFetchableUrl(tab.url)) {
    badgeError(tab.id, "open a PDF in this tab first");
    return;
  }

  // Local files need the per-extension "Allow access to file URLs" setting.
  // Without it the offscreen fetch would fail — send the user to the toggle.
  if (tab.url.startsWith("file://")) {
    const allowed = await new Promise((res) => chrome.extension.isAllowedFileSchemeAccess(res));
    if (!allowed) {
      badgeError(tab.id, "to search local files, turn on \"Allow access to file URLs\" on the page that just opened");
      chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
      return;
    }
  }

  processing.add(tab.id);
  badge(tab.id, "…", "Making this PDF searchable…");
  try {
    await ensureOffscreen();
    const url = tab.url.split("#")[0];
    const copyUrl = newCopyUrl(url);
    chrome.runtime.sendMessage({
      type: "fii-process",
      tabId: tab.id,
      url,
      lang: await getLang(),
      copyUrl,
      cache: COPY_CACHE,
      cacheKey: copyKey(copyUrl),
    });
  } catch (err) {
    processing.delete(tab.id);
    badgeError(tab.id, err.message || err);
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
    badgeError(msg.tabId, msg.message);
    return;
  }

  if (msg.type === "fii-done") {
    processing.delete(msg.tabId);
    finishJob(msg).catch((err) => console.error("[FindInImages] finish failed:", err));
  }
});

async function finishJob({ tabId, url, copyUrl, words }) {
  if (!copyUrl) {
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
    await deleteCopy(copyUrl);
    return;
  }

  const swaps = await getSwaps();
  swaps[tabId] = copyUrl;
  await setSwaps(swaps);
  // Chrome clears a tab's badge when it navigates, so flash the result only
  // once the copy has loaded.
  await navigateAndWait(tabId, copyUrl);
  badgeFlash(tabId, "✓", `Searchable — ${words} words added. Press Ctrl+F to search, Ctrl+Shift+F to restore.`, 6000);
}

function navigateAndWait(tabId, url, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const done = () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      resolve();
    };
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === "complete") done();
    };
    const timer = setTimeout(done, timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.update(tabId, { url }).catch(done);
  });
}

// ── Cleanup: delete copies when their tab goes away or navigates elsewhere ───
chrome.tabs.onRemoved.addListener((tabId) => dropSwap(tabId));

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.url) return;
  const swaps = await getSwaps();
  const copyUrl = swaps[tabId];
  if (copyUrl && changeInfo.url.split("#")[0] !== copyUrl) await dropSwap(tabId);
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
  caches.delete(COPY_CACHE); // drop copies left over from a previous version
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
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (typeof info.menuItemId === "string" && info.menuItemId.startsWith("fii-lang-")) {
    chrome.storage.local.set({ fii_ocr_lang: info.menuItemId.slice("fii-lang-".length) });
  }
});
