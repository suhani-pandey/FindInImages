## 8 How It Was Built: Phase by Phase

The extension was built one phase at a time, each shipped and tested before the next. Each phase answered the question the previous one raised.

| # | Phase | What it set out to solve | What it revealed |
| --- | --- | --- | --- |
| 1 | Extension skeleton & PDF interception | Chrome's viewer can't be scripted, so redirect `.pdf` navigations to our own viewer | A viewer that shows nothing yet |
| 2 | PDF.js rendering | Render pages to canvas inside the extension (bundled for MV3's CSP) | Pages display but nothing is searchable |
| 3 | Detection, OCR, invisible overlay | Native text + Tesseract OCR, injected as invisible DOM spans; switched from *either/or* to *both* with de-duplication | OCR re-runs on every load |
| 4 | IndexedDB cache | OCR once; normalized coordinates survive any zoom | Language data still came from a CDN |
| 5 | Fully offline | Bundle the language models | — |
| 6 | Correction variants | Exact-match find vs. OCR misreads (`he11o`) | Rotated pages misaligned |
| 7 | Rotated pages | Angle and size from the transform matrix | Non-English documents |
| 8 | Multi-language OCR | English / Danish, cached per language | Large PDFs were slow |
| 9 | Performance | Lazy rendering, idle-time indexing, parallel OCR workers | Selection and native find looked wrong |
| 10 | Readability & search UX | Measure-and-scale spans; custom find bar | Tables, small and faint text still missed |
| 11 | OCR preprocessing | 3000 px OCR canvas, sparse segmentation, contrast + sharpening | — |
| 12 | Activation on demand | Stop hijacking every PDF; `Ctrl+Shift+F` opens the OCR viewer only when wanted | Still a different viewer |
| 13 | Imitating the native viewer | Chrome-style toolbar, find bar and highlights; phrase search across words; hidden-tab rendering fix | The user's verdict: an imitation is not the original |
| 14 | Native viewer only | Delete the viewer; write OCR text *into a copy* (sandwich PDF) and show it in Chrome's viewer | The tab switch was never tested in real Chrome |
| 15 | First use in the user's browser | Relaxed-SIMD Tesseract core crashed → patched out; Mac shortcut showed "Not set" | — |
| 16 | Release hardening in real Chrome | End-to-end tests of the packaged extension; fixes below | Ready to publish |

### 8.1 The two reversals

**From automatic to on demand (Phase 12).** Intercepting every PDF replaced Chrome's viewer even for text PDFs that were already searchable. That threw away the native toolbar, thumbnails, printing, Google Lens and right-click menu while adding nothing. The extension's value is real only for scanned PDFs, so it became opt-in.

**From a custom viewer to none (Phases 13–14).** The on-demand viewer was then made to look like Chrome's, down to the find bar and highlight colours. The user's requirement was sharper: "same behaviour as that of original … and same design and view also", with no different view and no change to the PDF's format. No imitation can meet that. Giving Chrome a *file* that contains the text can, so about 1,300 lines of viewer code were deleted and replaced by the searchable-copy pipeline. The original file is still never modified, and the copy's visible content was verified identical by pixel comparison (0 of 2,298,825 pixels differed).

### 8.2 Release hardening (Phase 16)

The first automated test of the *packaged* extension in real Chrome showed that the core feature had never worked. OCR completed and the copy existed, but Chrome silently refused to navigate a website tab to the extension's `blob:` URL. That led to the extension-origin delivery of Section 7.8. The same review and test suite also found:

- a release zip missing the `offscreen/` folder (the packaging script still listed the deleted viewer);
- the contrast-stretch failure on sparse pages (Section 7.4);
- the Mac shortcut never being assigned (Section 7.1);
- PDFs without ".pdf" in the URL being ignored;
- a URL-keyed cache that could apply old words to a changed file;
- Danish letters being stripped from word edges ("på" stored as "p");
- silent failures for encrypted PDFs, non-PDF pages and disabled file access, and a success badge Chrome erased on navigation;
- unbounded resources: pdf.js documents and OCR workers never released;
- store requirements: an over-long manifest description, a privacy policy, and listing material.

> **Lesson.** Every component had been tested, yet the product didn't work. The hardest late problems weren't algorithms but platform behaviour — what Chrome lets an extension do with blob URLs, shortcuts and badges — and they only appeared with the real browser in the loop.
