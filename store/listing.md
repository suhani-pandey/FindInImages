# Chrome Web Store submission — Find in Images

Everything to paste into the [Developer Dashboard](https://chrome.google.com/webstore/devconsole), plus a checklist.

## Before you submit

- [ ] One-time: register as a Chrome Web Store developer ($5) and verify your email.
- [ ] Push to `main` so GitHub Pages publishes the privacy policy and the sample PDF, then check that both URLs below open.
- [ ] `npm run test:e2e` passes.
- [ ] `npm run package` → upload `dist/find-in-images-<version>.zip`.
- [ ] Try the packaged build by hand once: unzip it, **Load unpacked**, open the sample PDF, press Ctrl+Shift+F (⌃⇧F on Mac), then Ctrl+F for "lighthouse". Check `chrome://extensions/shortcuts` shows the shortcut as set.
- [ ] Take screenshots (below).

## Store listing tab

**Name:** Find in Images

**Summary** (max 132 characters):
> Search scanned PDFs with Chrome's own Ctrl+F. On-device OCR adds an invisible text layer — nothing leaves your computer.

**Category:** Productivity → Tools

**Language:** English

**Description:**
> Scanned PDFs are just pictures of text, so Ctrl+F finds nothing in them. Find in Images fixes that, without replacing Chrome's PDF viewer.
>
> HOW TO USE
> 1. Open a scanned PDF in Chrome.
> 2. Press Ctrl+Shift+F (Control+Shift+F on Mac too) or click the toolbar icon.
> 3. When the badge shows ✓, press Ctrl+F and search as usual.
> Press Ctrl+Shift+F again to switch back to the original.
>
> WHAT IT DOES
> • Reads the text in the PDF's images with OCR (Tesseract), on your computer
> • Embeds that text as an invisible layer, the way professional scanners make "searchable PDFs"
> • Reopens the PDF in Chrome's own viewer, so everything looks and works exactly as before: search, highlight, copy and print
> • Handles mixed PDFs: pages with real text are left alone, and text inside images on those pages is added
> • Remembers results, so reopening a PDF is instant
> • Works with PDFs on sites you're signed in to, and with local files (after you allow file access)
> • OCR languages: English, Danish, or both (right-click the icon)
>
> PRIVATE BY DESIGN
> The OCR engine is bundled with the extension. Your PDFs are never uploaded anywhere, and there are no analytics or tracking.
>
> LIMITATIONS
> OCR isn't perfect, large PDFs take a few seconds per page, and password-protected PDFs can't be made searchable.

**Icon:** `icons/icon128.png`

**Screenshots** (1280×800, at least one; take them with the sample PDF):
1. A scanned PDF in Chrome's viewer with Ctrl+F finding a word (highlight visible). Caption: "Ctrl+F now finds text inside scanned pages."
2. The toolbar icon showing progress (`42%`) on the same PDF. Caption: "One shortcut — Ctrl+Shift+F — makes the PDF searchable."
3. The right-click menu on the icon with **OCR language** open. Caption: "Choose the OCR language."

**Small promo tile** (440×280, optional): the magnifier icon plus "Ctrl+F for scanned PDFs".

**Homepage URL:** https://suhani-pandey.github.io/FindInImages/

**Support URL:** https://github.com/suhani-pandey/FindInImages/issues

## Privacy practices tab

**Single purpose:**
> Make scanned (image-only) PDFs searchable with Chrome's built-in Find (Ctrl+F) by adding an OCR text layer on the user's device.

**Permission justifications:**

| Permission | Justification |
| --- | --- |
| `offscreen` | PDF rendering and OCR need a DOM canvas and web workers, which service workers don't have. They run in an offscreen document while the user's tab stays responsive. |
| `storage` | Stores the user's OCR language choice and which tabs are currently showing a searchable copy, so the copy can be cleaned up when the tab closes. |
| `contextMenus` | Adds the "OCR language" submenu to the toolbar icon's right-click menu. |
| Host permission `<all_urls>` | When the user triggers the extension on a tab showing a PDF, the extension downloads that same PDF to OCR it locally. PDFs can be hosted on any site (including sites the user is signed in to) or be local files, so access can't be limited to a fixed list of domains. The extension has no content scripts and never reads or modifies web pages. |

**Remote code:** No, I am not using remote code. (pdf.js, pdf-lib, Tesseract.js and the OCR language data are bundled in the package.)

**Data usage:** don't tick any data category. The PDF is processed on the device and never transmitted, so nothing is "collected" in the Web Store's sense. Tick all three certifications:
- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL:** https://suhani-pandey.github.io/FindInImages/privacy.html

## Distribution tab

**Visibility:** Public (or Unlisted for a soft launch).
**Regions:** All regions.

## Notes for the reviewer (optional field)

> To test: open https://suhani-pandey.github.io/FindInImages/sample-scan.pdf (an image-only scan), press Ctrl+Shift+F (Control+Shift+F on Mac, ⌃⇧F) or click the toolbar icon, wait for the ✓ badge, then press Ctrl+F and search for "lighthouse". Press Ctrl+Shift+F again to return to the original.
