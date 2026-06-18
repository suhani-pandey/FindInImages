#!/usr/bin/env node
/*
 * Find in Images — documentation builder.
 *
 *   node docs/build.mjs            build docs/DOCUMENTATION.pdf once
 *   node docs/build.mjs --watch    rebuild automatically on every save (real-time)
 *
 * Authoring model:
 *   - Each section is one Markdown file in docs/sections/ (e.g. 01-introduction.md).
 *     Files are concatenated in filename order, so the numeric prefix sets the order.
 *   - Diagrams are .svg files in docs/sections/diagrams/, referenced from Markdown as
 *     ![Figure N — caption](diagrams/name.svg). The builder inlines the SVG so the PDF
 *     is fully self-contained.
 *   - The cover page and table of contents are generated automatically (TOC from the
 *     ## and ### headings across all sections).
 *
 * No npm packages. Markdown -> HTML is a small built-in converter; HTML -> PDF uses the
 * Google Chrome you already have, driven over the DevTools protocol.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, rmSync, watch } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SECTIONS_DIR = join(HERE, "sections");
const OUTPUT = join(HERE, "DOCUMENTATION.pdf");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const CONFIG = {
  title: "Find in Images",
  subtitle:
    "Making scanned PDFs and image-based documents searchable with the browser’s native Ctrl+F, through on-device OCR and an invisible DOM text overlay.",
  tagline: "Technical Documentation & Design Rationale",
  footer: "Find in Images — Technical Documentation",
  version: "Version 1.0",
};

/* ----------------------------- Markdown -> HTML ----------------------------- */
const SENT = ""; // private-use sentinel for protected inline code
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const slug = (s) => s.toLowerCase().replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-");

function inline(text) {
  const codes = [];
  // protect inline code with a sentinel that cannot collide with ordinary text
  text = text.replace(/`([^`]+)`/g, (_, c) => { codes.push(`<code>${esc(c)}</code>`); return SENT + (codes.length - 1) + SENT; });
  text = esc(text);
  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, a, src) => `<img alt="${a}" src="${src}">`);
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, h) => `<a href="${h}">${t}</a>`);
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  text = text.replace(new RegExp(SENT + "(\\d+)" + SENT, "g"), (_, i) => codes[+i]);
  return text;
}

function inlineSvg(src, alt) {
  const file = join(SECTIONS_DIR, src);
  if (src.endsWith(".svg") && existsSync(file)) {
    const svg = readFileSync(file, "utf8").replace(/<\?xml[^>]*\?>/, "").trim();
    return `<figure class="fig">${svg}<figcaption>${inline(alt)}</figcaption></figure>`;
  }
  return `<figure class="fig"><img alt="${esc(alt)}" src="${src}"><figcaption>${inline(alt)}</figcaption></figure>`;
}

function mdToHtml(md, headings) {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0;
  const flushList = (items, ordered) => {
    const tag = ordered ? "ol" : "ul";
    out.push(`<${tag}>` + items.map((t) => `<li>${inline(t)}</li>`).join("") + `</${tag}>`);
  };

  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { i++; continue; }

    if (/^```/.test(line)) {
      i++; const buf = [];
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`);
      continue;
    }

    const mImg = line.match(/^!\[([^\]]*)\]\(([^)]+)\)\s*$/);
    if (mImg) { out.push(inlineSvg(mImg[2], mImg[1])); i++; continue; }

    const mH = line.match(/^(#{1,6})\s+(.*)$/);
    if (mH) {
      const level = mH[1].length, txt = mH[2].trim(), id = slug(txt);
      if ((level === 2 || level === 3) && headings) headings.push({ level, txt, id });
      out.push(`<h${level} id="${id}">${inline(txt)}</h${level}>`);
      i++; continue;
    }

    if (/^(\s*[-*_]){3,}\s*$/.test(line)) { out.push("<hr>"); i++; continue; }

    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const splitRow = (r) => r.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
      const header = splitRow(line); i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(splitRow(lines[i])); i++; }
      let t = "<table><thead><tr>" + header.map((c) => `<th>${inline(c)}</th>`).join("") + "</tr></thead><tbody>";
      for (const r of rows) t += "<tr>" + r.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>";
      out.push(t + "</tbody></table>");
      continue;
    }

    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ""));
      out.push(`<blockquote>${inline(buf.join(" "))}</blockquote>`);
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s+/, ""));
      flushList(items, false); continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+\.\s+/, ""));
      flushList(items, true); continue;
    }

    const buf = [line]; i++;
    while (i < lines.length && !/^\s*$/.test(lines[i]) &&
           !/^(#{1,6}\s|```|>\s?|\s*[-*]\s+|\s*\d+\.\s+|!\[|\|)/.test(lines[i]) &&
           !/^(\s*[-*_]){3,}\s*$/.test(lines[i])) {
      buf.push(lines[i++]);
    }
    out.push(`<p>${inline(buf.join(" "))}</p>`);
  }
  return out.join("\n");
}

/* ----------------------------- Page assembly ----------------------------- */
const CSS = `
:root{--ink:#1f2937;--ink-strong:#0f172a;--muted:#6b7280;--line:#e5e7eb;--blue:#2563eb;--purple:#7c3aed;--teal:#0d9488;--amber:#d97706;--green:#16a34a;--slate:#475569;--soft:#f6f8fa}
*{box-sizing:border-box}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{font:14.5px/1.62 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:var(--ink);margin:0}
h1,h2,h3,h4{color:var(--ink-strong);line-height:1.25}
h2{font-size:21px;margin:0 0 12px;padding-bottom:6px;border-bottom:2px solid var(--line)}
h3{font-size:16px;margin:20px 0 6px}
h4{font-size:13.5px;margin:15px 0 4px;color:var(--slate)}
p{margin:9px 0} a{color:var(--blue);text-decoration:none}
ul,ol{margin:8px 0 8px 22px;padding:0} li{margin:4px 0}
code{font-family:"SF Mono",Menlo,Consolas,monospace;font-size:.86em;background:var(--soft);padding:1px 5px;border-radius:4px}
pre{font-family:"SF Mono",Menlo,Consolas,monospace;font-size:11.6px;line-height:1.5;background:var(--soft);border:1px solid var(--line);border-radius:8px;padding:11px 13px;white-space:pre-wrap;word-break:break-word}
pre code{background:none;padding:0;font-size:inherit}
table{border-collapse:collapse;width:100%;font-size:12.8px;margin:12px 0}
th,td{border:1px solid var(--line);padding:7px 9px;text-align:left;vertical-align:top}
th{background:#f1f5f9;color:var(--ink-strong);font-weight:600}
tr:nth-child(even) td{background:#fafbfc}
blockquote{border-left:4px solid var(--purple);background:#faf5ff;padding:9px 13px;margin:12px 0;border-radius:0 6px 6px 0;font-size:13.3px}
.fig{margin:18px 0 6px;text-align:center} .fig svg{max-width:100%;height:auto}
figcaption{font-size:11.5px;color:var(--muted);margin-top:6px;font-style:italic}
.tag{display:inline-block;font-size:11px;font-weight:600;padding:1px 8px;border-radius:20px;color:#fff;margin:0 3px}
.t-blue{background:var(--blue)}.t-purple{background:var(--purple)}.t-teal{background:var(--teal)}.t-amber{background:var(--amber)}.t-green{background:var(--green)}
.cover{height:9.7in;display:flex;flex-direction:column;justify-content:center;text-align:center}
.cover .kicker{letter-spacing:.22em;text-transform:uppercase;color:var(--muted);font-size:12px;font-weight:600}
.cover h1{font-size:42px;margin:14px 0 8px}
.cover .sub{font-size:16px;color:var(--slate);max-width:560px;margin:0 auto}
.cover .lens{margin:26px auto 20px} .cover .tagline{font-size:14px;color:var(--muted)}
.cover .stack{margin-top:16px} .cover .meta{margin-top:28px;font-size:12.5px;color:var(--muted)}
.toc h2{margin-bottom:14px} .toc a{color:var(--ink-strong)}
.toc ul{list-style:none;margin-left:0} .toc li{margin:5px 0;font-size:13.5px}
.toc .lvl3{margin-left:22px;font-size:12.7px;color:var(--slate)} .toc .lvl3 a{color:var(--slate)}
section{page-break-before:always} section.cover-sec{page-break-before:auto}
.fig,pre,table,blockquote{page-break-inside:avoid} h2,h3,h4{page-break-after:avoid}
`;

const COVER_LENS = `
<svg width="150" height="150" viewBox="0 0 150 150" aria-hidden="true">
  <circle cx="62" cy="62" r="40" fill="none" stroke="#2563eb" stroke-width="9"/>
  <line x1="92" y1="92" x2="128" y2="128" stroke="#2563eb" stroke-width="11" stroke-linecap="round"/>
  <text x="48" y="58" font-family="monospace" font-size="22" fill="#7c3aed" font-weight="700">A</text>
  <text x="64" y="74" font-family="monospace" font-size="22" fill="#0d9488" font-weight="700">&#12354;</text>
</svg>`;

function buildHtml() {
  const files = readdirSync(SECTIONS_DIR).filter((f) => f.endsWith(".md")).sort();
  if (files.length === 0) throw new Error("No section .md files found in " + SECTIONS_DIR);

  const headings = [];
  const bodies = files.map((f) => mdToHtml(readFileSync(join(SECTIONS_DIR, f), "utf8"), headings));

  const toc = headings.map((h) =>
    h.level === 2
      ? `<li><a href="#${h.id}">${inline(h.txt)}</a></li>`
      : `<li class="lvl3"><a href="#${h.id}">${inline(h.txt)}</a></li>`
  ).join("");

  const cover = `
<section class="cover-sec"><div class="cover">
  <div class="kicker">Chrome Extension &middot; Manifest V3</div>
  <h1>${CONFIG.title}</h1>
  <div class="sub">${CONFIG.subtitle}</div>
  <div class="lens">${COVER_LENS}</div>
  <div class="tagline">${CONFIG.tagline}</div>
  <div class="stack">
    <span class="tag t-blue">JavaScript ES6+</span><span class="tag t-purple">PDF.js</span>
    <span class="tag t-teal">Tesseract.js</span><span class="tag t-amber">IndexedDB</span>
    <span class="tag t-green">Canvas / DOM</span>
  </div>
  <div class="meta">${CONFIG.version} &middot; Architecture, implementation &amp; phase-by-phase build narrative</div>
</div></section>`;

  const tocSection = `<section class="toc"><h2>Contents</h2><ul>${toc}</ul></section>`;
  const content = bodies.map((b) => `<section>${b}</section>`).join("\n");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${CONFIG.title}</title><style>${CSS}</style></head><body>${cover}${tocSection}${content}</body></html>`;
}

/* ----------------------------- HTML -> PDF (Chrome) ----------------------------- */
async function htmlToPdf(html) {
  const tmpHtml = join(HERE, ".doc-build.html");
  writeFileSync(tmpHtml, html);
  const fileUrl = "file://" + encodeURI(tmpHtml);
  const profile = join("/tmp", `fii-doc-${Date.now()}`);
  const PORT = 9588;

  const footer =
    `<div style="font-size:8px;width:100%;text-align:center;color:#9aa0a6;font-family:-apple-system,Arial,sans-serif;">` +
    `${CONFIG.footer} &nbsp;&middot;&nbsp; Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>`;

  let chrome;
  try {
    chrome = spawn(CHROME, [
      "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
      "--hide-scrollbars", `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, "about:blank",
    ], { stdio: "ignore" });

    let ready = false;
    for (let n = 0; n < 100; n++) {
      try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) { ready = true; break; } } catch {}
      await sleep(100);
    }
    if (!ready) throw new Error("DevTools endpoint not ready");

    let target = null;
    for (let n = 0; n < 30; n++) {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      target = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (target) break; await sleep(100);
    }
    if (!target) throw new Error("No page target");

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", () => rej(new Error("ws error")), { once: true });
    });

    let id = 0; const pending = new Map();
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== undefined && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id);
        m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
      }
    });
    const send = (method, params = {}) =>
      new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
    const waitEvent = (method, t = 20000) =>
      new Promise((res, rej) => {
        const to = setTimeout(() => { ws.removeEventListener("message", on); rej(new Error("timeout " + method)); }, t);
        function on(ev) { const m = JSON.parse(ev.data); if (m.method === method) { clearTimeout(to); ws.removeEventListener("message", on); res(m.params); } }
        ws.addEventListener("message", on);
      });

    await send("Page.enable");
    const loaded = waitEvent("Page.loadEventFired");
    await send("Page.navigate", { url: fileUrl });
    await loaded;
    await sleep(700);

    const { data } = await send("Page.printToPDF", {
      printBackground: true, paperWidth: 8.27, paperHeight: 11.69,
      marginTop: 0.55, marginBottom: 0.7, marginLeft: 0.55, marginRight: 0.55,
      displayHeaderFooter: true, headerTemplate: "<span></span>", footerTemplate: footer,
    });
    writeFileSync(OUTPUT, Buffer.from(data, "base64"));
    ws.close();
  } catch (e) {
    console.warn("  (CDP failed: " + e.message + " — using --print-to-pdf fallback)");
    execFileSync(CHROME, ["--headless=new", "--disable-gpu", "--no-pdf-header-footer",
      `--user-data-dir=${profile}-fb`, `--print-to-pdf=${OUTPUT}`, fileUrl], { stdio: "ignore" });
  } finally {
    try { chrome?.kill("SIGKILL"); } catch {}
    for (const d of [profile, profile + "-fb"]) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
    try { rmSync(tmpHtml, { force: true }); } catch {}
  }
}

async function build() {
  const t0 = Date.now();
  await htmlToPdf(buildHtml());
  const kb = existsSync(OUTPUT) ? (statSync(OUTPUT).size / 1024).toFixed(0) : "?";
  console.log(`✓ DOCUMENTATION.pdf rebuilt (${kb} KB) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

const WATCH = process.argv.includes("--watch");
await build();

if (WATCH) {
  console.log("\u{1F440} Watching docs/sections/ — edit any .md or .svg and the PDF updates automatically. Ctrl+C to stop.");
  let timer = null;
  const trigger = () => { clearTimeout(timer); timer = setTimeout(() => build().catch((e) => console.error(e)), 250); };
  watch(SECTIONS_DIR, { recursive: true }, trigger);
}
