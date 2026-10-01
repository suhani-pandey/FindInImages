// End-to-end test of the PACKAGED extension in real Chrome.
//
//   npm run test:e2e            (packages, unzips to a temp dir, runs)
//   node test/e2e/run.mjs <dir> (run against an already-unpacked extension)
//
// Loads the extension into a throwaway Chrome profile through the DevTools
// protocol (--remote-debugging-pipe + Extensions.loadUnpacked, which branded
// Chrome still allows for automation), serves the fixture PDFs from a local
// server, calls the service worker's toggle() the way the toolbar button
// would, and checks the searchable copy Chrome ends up showing.
//
// Env: CHROME=<path to the Chrome binary>, HEADFUL=1 to watch it run.
//
// Fixtures are US Letter pages rendered at 300 DPI and saved as image-only
// PDFs (no text layer), like a scanner produces; locked/owner.pdf are a.pdf
// with an open password / permissions-only password.

import { spawn, execSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const FIXTURES = path.join(HERE, "fixtures");
const CHROME = process.env.CHROME || {
  darwin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  linux: "google-chrome",
  win32: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
}[process.platform];
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fii-e2e-"));
const pdfjs = await import(path.join(REPO, "node_modules/pdfjs-dist/legacy/build/pdf.mjs"));

// ── Extension under test ─────────────────────────────────────────────────────
let EXT = process.argv[2];
if (!EXT) {
  const { version } = JSON.parse(fs.readFileSync(path.join(REPO, "manifest.json"), "utf8"));
  execSync("npm run -s package", { cwd: REPO, stdio: "ignore" });
  EXT = path.join(TMP, "ext");
  execSync(`unzip -q "dist/find-in-images-${version}.zip" -d "${EXT}"`, { cwd: REPO });
}

// ── Test server ──────────────────────────────────────────────────────────────
let latest = "a.pdf"; // what /latest.pdf serves (switched mid-test)
const server = http.createServer((req, res) => {
  const pdf = (f) => {
    res.writeHead(200, { "content-type": "application/pdf" });
    res.end(fs.readFileSync(path.join(FIXTURES, f)));
  };
  const html = (s) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(s);
  };
  const u = decodeURIComponent(req.url.split("?")[0]);
  if (u === "/page.html") return html("<h1>Not a PDF</h1>");
  if (["/a.pdf", "/c.pdf", "/locked.pdf", "/owner.pdf"].includes(u)) return pdf(u.slice(1));
  if (u === "/files/Quarterly Report") return pdf("a.pdf"); // no .pdf in the URL
  if (u === "/latest.pdf") return pdf(latest);
  if (u === "/private/doc") {
    // A PDF behind a sign-in cookie; without it the server redirects to a form.
    if (/(^|;\s*)session=ok/.test(req.headers.cookie || "")) return pdf("b.pdf");
    res.writeHead(302, { location: "/login" });
    return res.end();
  }
  if (u === "/login") return html("<form>Sign in</form>");
  res.writeHead(404);
  res.end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// ── Chrome over the DevTools pipe ────────────────────────────────────────────
const chrome = spawn(CHROME, [
  ...(process.env.HEADFUL ? [] : ["--headless"]),
  "--remote-debugging-pipe", "--enable-unsafe-extension-debugging",
  `--user-data-dir=${path.join(TMP, "profile")}`, "--no-first-run", "--no-default-browser-check",
  "--use-mock-keychain", "--password-store=basic", "--window-size=1200,900",
  "about:blank",
], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });

const toChrome = chrome.stdio[3], fromChrome = chrome.stdio[4];
fromChrome.setEncoding("utf8");
let buf = "", nextId = 0;
const pending = new Map(), extensionErrors = [];
fromChrome.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\0")) >= 0) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
    } else if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      extensionErrors.push(d.exception?.description || d.text);
    }
  }
});
const send = (method, params = {}, sessionId) => {
  const id = ++nextId;
  toChrome.write(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }) + "\0");
  return new Promise((res, rej) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      rej(new Error(`DevTools call timed out: ${method}`));
    }, 30000);
    pending.set(id, {
      res: (v) => { clearTimeout(timer); res(v); },
      rej: (e) => { clearTimeout(timer); rej(e); },
    });
  });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;
const brief = (s) => s.replace(/\s+/g, " ").slice(0, 160);

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

try {
  const { id: extId } = await send("Extensions.loadUnpacked", { path: EXT });
  const COPY_PREFIX = `chrome-extension://${extId}/searchable/`;

  // Attach to the extension's service worker to drive it.
  let swTarget;
  for (let i = 0; i < 50 && !swTarget; i++) {
    const { targetInfos } = await send("Target.getTargets");
    swTarget = targetInfos.find((t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${extId}/`));
    if (!swTarget) await sleep(200);
  }
  const { sessionId: sw } = await send("Target.attachToTarget", { targetId: swTarget.targetId, flatten: true });
  await send("Runtime.enable", {}, sw);
  const evalSW = async (body) => {
    const r = await send("Runtime.evaluate", {
      expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true,
    }, sw);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  // Also collect uncaught errors from the offscreen document once it exists.
  let offscreenAttached = false;
  const attachOffscreen = async () => {
    if (offscreenAttached) return;
    const { targetInfos } = await send("Target.getTargets");
    const t = targetInfos.find((t) => t.url.includes(`${extId}/offscreen/offscreen.html`));
    if (!t) return;
    const { sessionId } = await send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
    await send("Runtime.enable", {}, sessionId);
    offscreenAttached = true;
  };

  const openTab = async (url) => {
    await send("Target.createTarget", { url });
    for (let i = 0; i < 50; i++) {
      const id = await evalSW(`const t = (await chrome.tabs.query({})).find((t) => (t.url || t.pendingUrl) === ${J(url)}); return t ? t.id : null;`);
      if (id) {
        await sleep(1500); // let the PDF viewer finish loading
        return id;
      }
      await sleep(200);
    }
    throw new Error("tab not found: " + url);
  };
  const tab = (id) => evalSW(`return await chrome.tabs.get(${id});`);
  const trigger = (id) => evalSW(`toggle(await chrome.tabs.get(${id})); return true;`);
  const badgeOf = (id) => evalSW(`return { text: await chrome.action.getBadgeText({ tabId: ${id} }), title: await chrome.action.getTitle({ tabId: ${id} }) };`);
  const copyCount = () => evalSW(`return (await (await caches.open("fii-copies")).keys()).length;`);

  // Wait until the tab shows a searchable copy, or the badge reports an error.
  const waitResult = async (id, timeoutMs = 240000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      await attachOffscreen();
      const b = await badgeOf(id);
      if (b.text === "!") return { error: b.title, ms: Date.now() - t0 };
      const t = await tab(id);
      if (t.url.startsWith(COPY_PREFIX) && t.status === "complete") return { copy: t.url, ms: Date.now() - t0 };
      if (b.text === "✓" && b.title.includes("already searchable")) return { already: true, ms: Date.now() - t0 };
      await sleep(500);
    }
    return { timeout: true, badge: await badgeOf(id), url: (await tab(id)).url };
  };

  // Read a copy's bytes out of Cache Storage and extract its text layer.
  const copyText = async (copyUrl) => {
    const b64 = await evalSW(`
      const key = "https://find-in-images.invalid" + new URL(${J(copyUrl)}).pathname;
      const bytes = new Uint8Array(await (await (await caches.open("fii-copies")).match(key)).arrayBuffer());
      let s = "";
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(s);`);
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(Buffer.from(b64, "base64")),
      standardFontDataUrl: path.join(REPO, "node_modules/pdfjs-dist/standard_fonts/"),
    }).promise;
    let text = "";
    for (let p = 1; p <= doc.numPages; p++) {
      text += (await (await doc.getPage(p)).getTextContent()).items.map((i) => i.str).join(" ") + " ";
    }
    return { text: text.replace(/\s+/g, " "), pages: doc.numPages };
  };

  // The keyboard shortcut is actually assigned (Chrome silently leaves a
  // suggested key unset when it clashes, e.g. Cmd+Shift+F on Mac)
  {
    const cmds = await evalSW(`return await chrome.commands.getAll();`);
    const cmd = cmds.find((c) => c.name === "toggle-search");
    check("keyboard shortcut is assigned", !!(cmd && cmd.shortcut), cmd ? `"${cmd.shortcut}"` : J(cmds));
  }

  // Non-PDF page → clear error, no swap
  {
    const id = await openTab(`${BASE}/page.html`);
    await trigger(id);
    const r = await waitResult(id, 20000);
    check("non-PDF page reports an error", !!r.error && /isn't a PDF/.test(r.error), r.error);
  }

  // Scanned PDF → OCR, swap in the native viewer, searchable, same tab title
  let firstOcrMs;
  {
    const id = await openTab(`${BASE}/a.pdf`);
    const before = await tab(id);
    await trigger(id);
    const r = await waitResult(id);
    firstOcrMs = r.ms;
    check("scanned PDF is swapped to a searchable copy", !!r.copy, r.error || (r.timeout ? J(r) : `${r.ms} ms`));
    if (r.copy) {
      const { text, pages } = await copyText(r.copy);
      check("copy's text layer has the page's words",
        /Zebra Quarterly Summary/.test(text) && /lighthouse renovation/.test(text) &&
        /Small print/.test(text) && /X-4471/.test(text) && /1,284\.50/.test(text), brief(text));
      check("copy has the same page count", pages === 1);
      check("tab title unchanged after swap", (await tab(id)).title === before.title);
      await sleep(700);
      const b = await badgeOf(id);
      check("success badge shown after the copy loads", b.text === "✓" && b.title.includes("words added"), b.title);

      await evalSW(`await chrome.tabs.reload(${id}); return 1;`);
      await sleep(2000);
      check("reloading the copy still shows the copy", (await tab(id)).url === r.copy);

      await trigger(id);
      await sleep(2000);
      check("second trigger restores the original PDF", (await tab(id)).url === `${BASE}/a.pdf`);
      check("restoring deletes the stored copy", (await copyCount()) === 0);
    }
  }

  // PDF URL without ".pdf" → processed; same bytes reuse the content-hash OCR cache
  {
    const id = await openTab(`${BASE}/files/Quarterly%20Report`);
    const before = await tab(id);
    await trigger(id);
    const r = await waitResult(id);
    check("PDF without .pdf in its URL is processed", !!r.copy, r.error || `${r.ms} ms (first OCR took ${firstOcrMs} ms)`);
    if (r.copy) {
      check("…keeps its tab title", (await tab(id)).title === before.title);
      // The copy disappears (as after a browser restart) → reload falls back
      await evalSW(`await caches.delete("fii-copies"); await chrome.tabs.reload(${id}); return 1;`);
      await sleep(2500);
      check("expired copy falls back to the original PDF", (await tab(id)).url === `${BASE}/files/Quarterly%20Report`);
    }
  }

  // PDF behind a sign-in cookie
  {
    await send("Storage.setCookies", { cookies: [{ name: "session", value: "ok", domain: "127.0.0.1", path: "/" }] });
    const id = await openTab(`${BASE}/private/doc`);
    await trigger(id);
    const r = await waitResult(id);
    check("PDF behind a sign-in cookie is processed", !!r.copy, r.error || `${r.ms} ms`);
    if (r.copy) {
      const { text } = await copyText(r.copy);
      check("…with the signed-in document's words", /Walrus Annual Receipt/.test(text) && /Seventeen penguins/.test(text), brief(text));
      const n = await copyCount();
      await evalSW(`await chrome.tabs.remove(${id}); return 1;`);
      await sleep(1000);
      check("closing the tab deletes its copy", (await copyCount()) === n - 1);
    }
  }

  // Same URL, different file → the OCR cache must not reuse the old file's words
  {
    latest = "a.pdf";
    const id = await openTab(`${BASE}/latest.pdf`);
    await trigger(id);
    await waitResult(id);
    await trigger(id); // restore
    await sleep(1500);
    latest = "b.pdf";
    await evalSW(`await chrome.tabs.reload(${id}, { bypassCache: true }); return 1;`);
    await sleep(2000);
    await trigger(id);
    const r = await waitResult(id);
    check("changed file at the same URL is processed", !!r.copy, r.error || `${r.ms} ms`);
    if (r.copy) {
      const { text } = await copyText(r.copy);
      check("…with the new file's words only", /Walrus/.test(text) && !/Zebra/.test(text), brief(text));
    }
  }

  // Encrypted PDFs → clear message
  for (const f of ["locked.pdf", "owner.pdf"]) {
    const id = await openTab(`${BASE}/${f}`);
    await trigger(id);
    const r = await waitResult(id, 60000);
    check(`encrypted PDF (${f}) reports a clear error`, !!r.error && /encrypted/.test(r.error), r.error || J(r));
  }

  // Local file (the result depends on the profile's "Allow access to file URLs")
  {
    const url = pathToFileURL(path.join(FIXTURES, "a.pdf")).href;
    await send("Target.createTarget", { url });
    await sleep(2000);
    const tabs = await evalSW(`return (await chrome.tabs.query({})).map((t) => ({ id: t.id, url: t.url || null, title: t.title }));`);
    const t = tabs.find((t) => t.url === url);
    if (!t) {
      check("local file tab found", false, J(tabs));
    } else {
      const allowed = await evalSW(`return await new Promise((r) => chrome.extension.isAllowedFileSchemeAccess(r));`);
      await trigger(t.id);
      if (allowed) {
        const r = await waitResult(t.id);
        check("local file is processed", !!r.copy, r.error || `${r.ms} ms`);
        if (r.copy) {
          await trigger(t.id);
          await sleep(1500);
          check("…and restores to the file:// URL", (await tab(t.id)).url === url);
        }
      } else {
        await sleep(1500);
        const b = await badgeOf(t.id);
        check("local file without file access gives guidance", b.text === "!" && /file URLs/.test(b.title), b.title);
      }
    }
  }

  // OCR workers are released after 60 s idle and recreated for the next job
  {
    console.log("      (waiting 65 s for the idle OCR-worker release)");
    await sleep(65000);
    const id = await openTab(`${BASE}/c.pdf`);
    await trigger(id);
    const r = await waitResult(id);
    check("OCR works again after the idle worker release", !!r.copy, r.error || `${r.ms} ms`);
    if (r.copy) {
      const { text } = await copyText(r.copy);
      check("…with correct words", /Pelican Delivery Note/.test(text) && /ZX-4471/.test(text), brief(text));
    }
  }
} catch (err) {
  console.error("RUN FAILED:", err);
  results.push({ name: "run", ok: false });
} finally {
  // Expected failures (non-PDF, encrypted) are logged by the extension with
  // console.error, not thrown, so anything here is a real uncaught error.
  if (extensionErrors.length) {
    console.log("\nUncaught errors in the extension:\n  " + extensionErrors.slice(0, 20).join("\n  "));
  }
  const failed = results.filter((r) => !r.ok).length + extensionErrors.length;
  console.log(`\n${results.length - results.filter((r) => !r.ok).length}/${results.length} checks passed`);
  chrome.kill();
  server.close();
  setTimeout(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    process.exit(failed ? 1 : 0);
  }, 500);
}
