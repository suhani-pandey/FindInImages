# 🔍 Find in Images

A Chrome extension that makes **scanned PDFs searchable with Chrome's own Ctrl+F**.

Open a scanned PDF, press **Ctrl+Shift+F** (Control+Shift+F on Mac too), and the extension reads the text in the page images with OCR and reopens the PDF in Chrome's built-in viewer with an invisible text layer. The normal **Ctrl+F** then finds words that were only pictures before. Nothing changes visually: same viewer, same toolbar, same look.

Everything runs on your computer. Nothing is uploaded anywhere.

---

## Using it

1. Open a PDF in Chrome (any site, or a local file).
2. Press **Ctrl+Shift+F** (on Mac: **Control**+Shift+F, ⌃⇧F), or click the toolbar icon.
3. Watch the badge on the icon: `…` → `42%` → `✓`. The tab then shows the searchable copy.
4. Press **Ctrl+F** (**⌘F** on Mac) and search as usual: it's Chrome's own search bar, which can now find the words.
5. Press **Ctrl+Shift+F** again to switch back to the original.

The OCR language (English, Danish, or both) is set by right-clicking the toolbar icon and choosing **OCR language**.

If something goes wrong, the badge turns into a red **!**. Hover over the icon to see why (for example, the file is encrypted, or the page isn't a PDF).

**Local files** need one extra step: in `chrome://extensions` → Find in Images → **Details**, turn on **Allow access to file URLs**. If it is off, the extension opens that page for you.

---

## How it works

```text
Ctrl+Shift+F on a PDF tab
   ↓
Service worker ──► offscreen document
                     1. download the PDF (with the user's cookies)
                     2. pdf.js: which pages paint images / have no text?
                     3. render those pages at ~3000 px; fix contrast,
                        sharpen, erase table borders
                     4. Tesseract.js OCR in three passes → words + lines:
                        · the whole page
                        · coloured/dark areas (white text on tiles,
                          buttons) re-rendered at up to 3x and read alone
                        · the page turned sideways (vertical axis labels)
                     5. pdf-lib: write each OCR line into the page as
                        INVISIBLE text (render mode 3), every word sized to
                        cover the visible one, real spaces between words
                     6. store the copy in Cache Storage
   ↓
tab → chrome-extension://…/searchable/<id>/<file name>?src=<original URL>
   ↓
service worker's fetch handler serves the copy → Chrome's native PDF viewer
```

This is the classic "searchable scan" (OCR sandwich) technique that scanners and `ocrmypdf` use, applied inside the browser.

- **Native viewer only.** The copy is a real PDF, so Chrome's viewer handles search, highlighting, copy and print. The copy's URL ends in the original file name, so the tab title stays the same.
- **Mixed PDFs.** Pages that already have real text are skipped. Text inside images on those pages is still OCR'd, and words the PDF already contains aren't duplicated.
- **OCR cache.** Results are cached in IndexedDB by a SHA-256 hash of the file, so reopening a PDF is instant even from another URL. A changed file at the same URL is never matched to stale results. The cache prunes itself (least-recently-used) past 2,000 pages.
- **Lifetime.** Copies are deleted when you restore the original, navigate away, close the tab or restart Chrome. A tab that comes back after a restart simply loads the original PDF. OCR workers are shut down after a minute idle to free memory.

### Project layout

| Path | What it is |
| --- | --- |
| `manifest.json` | MV3 manifest |
| `service-worker.js` | Toolbar/shortcut trigger, badge, tab swap, serves copies |
| `offscreen/offscreen.js` | Job queue in the offscreen document |
| `offscreen/processor.js` | The pipeline: download → detect → OCR → embed |
| `offscreen/ocr.js` | Page rendering, preprocessing, Tesseract worker pool |
| `offscreen/embed.js` | Writes invisible text with pdf-lib |
| `offscreen/ocr-postprocess.js` | OCR clean-up and misread corrections (`he11o` → `hello`) |
| `offscreen/cache.js` | IndexedDB OCR cache |
| `lib/` | Vendored pdf.js, pdf-lib, Tesseract.js and language data (no CDN) |
| `test/e2e/` | End-to-end test in real Chrome, with scanned-PDF fixtures |

`lib/tesseract/worker.min.js` is patched so Tesseract never selects its WASM relaxed-SIMD build, which crashes on some Chrome/Apple Silicon builds. Only the SIMD and plain LSTM cores are bundled, so keep the patch if you update Tesseract.js.

---

## Development

```bash
npm install          # pdfjs-dist is used by the e2e test
npm run package      # → dist/find-in-images-<version>.zip (upload this to the Web Store)
npm run test:e2e     # packages, loads the zip into a throwaway Chrome profile, runs the checks
```

To try it by hand: `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select this folder.

`test:e2e` drives real Chrome through the DevTools protocol. It covers the scanned-PDF swap, tab title, reload, restore, URLs without `.pdf`, sign-in cookies, changed files, encrypted PDFs, local files, copy cleanup and OCR after worker release. It also checks reading accuracy on hard cases: a word repeated 17 times in tables, buttons, small print and italics; a screenshot with a white-on-dark button; and a lecture-style slide with white text on coloured tiles and a sideways axis title. Set `CHROME=/path/to/chrome` if Chrome isn't in the default location, or `HEADFUL=1` to watch.

---

## Limitations

- OCR isn't perfect: expect occasional misread characters, especially in low-quality scans.
- Large PDFs take a while (a few seconds per scanned page, depending on the machine); the badge shows progress.
- Password-protected or encrypted PDFs can't be modified, so they can't be made searchable.
- Searchable text is limited to the Latin-1 character set (fine for English and Danish).
- A PDF that can't be downloaded again (for example, one produced by a form submission) can't be processed.

## Privacy

No data leaves your computer. See the [privacy policy](https://suhani-pandey.github.io/FindInImages/privacy.html).

## License

Find in Images is released under the [MIT License](LICENSE). The bundled third-party libraries keep their own licenses (see below).

## Acknowledgements and licenses

Built on [PDF.js](https://mozilla.github.io/pdf.js/) (Apache-2.0), [Tesseract.js](https://tesseract.projectnaptha.com/) and the Tesseract OCR engine (Apache-2.0), and [pdf-lib](https://pdf-lib.js.org/) (MIT). The OCR engine also includes Leptonica, libjpeg, libpng, libtiff, libwebp, giflib, zlib and OpenLibm. Every bundled component and its full license text is listed in [THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt), which ships inside the extension package. `lib/tesseract/worker.min.js` is modified, as described there.

This software is based in part on the work of the Independent JPEG Group.
