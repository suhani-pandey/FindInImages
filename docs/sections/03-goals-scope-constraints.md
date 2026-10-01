## 3 Goals, Scope & Constraints

### 3.1 Goals

- **Accurate, findable image text.** The headline feature: text inside images must be reliably found by `Ctrl+F`. This is the project's top priority.
- **Native experience, unchanged.** Chrome's own viewer, toolbar, find bar, highlights and right-click menu — nothing to learn, nothing that looks different.
- **One reversible gesture.** `Ctrl+Shift+F` (or the toolbar icon) makes the open PDF searchable; the same gesture brings the original back.
- **Works where PDFs are.** Links without `.pdf` in the address, sites the user is signed in to, and local files.
- **Responsive.** The tab stays usable while OCR runs in the background; progress is visible on the toolbar icon.
- **Offline and private.** No network calls beyond re-downloading the PDF itself; OCR and language models run entirely on-device.
- **Selectable and copyable text.** Recovered text can be selected and copied like any other PDF text.

### 3.2 Constraints

> **Hard constraint 1 — the original PDF is never modified.** The source file is downloaded, read, and left untouched. Only a *copy* receives the invisible text layer, and invisible text paints nothing, so the copy looks identical.

> **Hard constraint 2 — Chrome's own viewer is the only UI.** No custom viewer, overlay, or find bar. A Chrome look-alike viewer was built and rejected: "same behaviour … same design and view" means the real thing, not an imitation.

Together these rule out every overlay-based design and lead directly to the searchable-copy architecture in Section 5.

### 3.3 Non-goals

- Editing, annotating, or re-saving PDFs for the user.
- Server-side or cloud OCR (everything is on-device by design).
- Perfect OCR. OCR is inherently imperfect; the system is designed to *maximise findability despite* recognition errors (Section 7.6) rather than to guarantee character-perfect transcription.
- Searching images on ordinary web pages. The extension has no content scripts and never touches web pages.
