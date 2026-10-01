## 9 Testing & Release

### 9.1 End-to-end test in real Chrome

```bash
npm run test:e2e
```

The test builds the release zip, unpacks it, and launches Google Chrome with a throwaway profile over the DevTools protocol (`--remote-debugging-pipe`). It loads the extension with `Extensions.loadUnpacked`, which branded Chrome still allows for automation. It then attaches to the extension's service worker and calls the same `toggle()` the toolbar icon calls. A local HTTP server plays the web, and each check observes what Chrome actually did (tab URL and title, toolbar badge). The copy is read back out of Cache Storage and its text extracted with an independent PDF.js.

| Scenario | Verified |
| --- | --- |
| Shortcut | Chrome actually assigns `Ctrl+Shift+F` (⌃⇧F on Mac) |
| Scanned PDF | Tab switches to the copy; copy's text has the page's words; same page count and tab title; success badge |
| Reload / restore | Reload keeps the copy; the gesture restores the original and deletes the copy |
| URL without ".pdf" | Processed; tab title kept; OCR cache reused across URLs |
| Expired copy | Reloading after the copy is gone lands on the original |
| Signed-in PDF | Cookie-protected PDF processed; closing the tab deletes its copy |
| Changed file, same URL | New file's words only |
| Encrypted PDFs | Open-password and permissions-only PDFs report a clear error |
| Non-PDF page | "Not a PDF" error |
| Local file | Processed and restored (with file access on) |
| Idle worker release | OCR still correct after the workers were released |

Fixtures (`test/e2e/fixtures/`) are US Letter pages rendered at 300 DPI and saved as image-only PDFs, like scanner output. On them, OCR found all 74 words of the dense page (one character misread) and read the other two word for word, tables included. A one-page scan takes about 2–2.5 s from shortcut to searchable copy on the development Mac, about 0.5 s when cached.

`CHROME=/path/to/chrome` overrides the browser location; `HEADFUL=1` shows the window.

### 9.2 Packaging and publishing

```bash
npm run package     # → dist/find-in-images-<version>.zip
```

The zip contains `manifest.json`, `service-worker.js`, `icons/`, `lib/` and `offscreen/` (about 8.5 MB). Publishing on the Chrome Web Store needs a developer account, the privacy policy (published with this documentation at `/privacy.html`), screenshots, and a justification for each permission. `store/listing.md` contains all of it, ready to paste.
