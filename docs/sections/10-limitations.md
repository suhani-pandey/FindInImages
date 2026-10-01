## 10 Limitations & Future Work

### 10.1 Limitations

- **OCR isn't perfect.** Native find is exact, so a misread character can hide a word; correction variants only cover common digit/letter confusions.
- **Whole document first.** The copy appears when every page is done; large scans take a while (the badge shows progress).
- **Encrypted PDFs** can't be written to, so they are reported and left alone.
- **Latin characters only.** The invisible text uses Helvetica's WinAnsi encoding: fine for English and Danish, not for Greek, Cyrillic or CJK.
- **The PDF must be downloadable again.** PDFs from form submissions or one-time links can't be fetched a second time; PDFs inside another site's viewer aren't PDF tabs.
- **The address bar changes** to `chrome-extension://…/searchable/…` while the copy is shown — the one visible sign of the switch.
- **Broad host access.** Downloading a PDF from wherever it lives needs access to all sites; it is used only when the user invokes the extension.
- **Large type at the OCR resolution.** The 3000 px render suits normal text sizes; on pages with unusually large type, Tesseract can skip bordered table cells.
- **Small evaluation.** A few clean, synthetic scans on one machine and one Chrome version.

### 10.2 Future work

- Process pages in reading order and offer a partial copy early for long documents.
- Embed a subsetted Unicode font for non-Latin scripts; more languages; automatic script detection.
- Dictionary-based correction, deskew, and OCR at more than one scale.
- Ask for access to a site only when the user invokes the extension there, once verified that this covers downloading the PDF.
- A benchmark on real scans (character and word error rates, per-page latency).
