## 3 Goals, Scope & Constraints

### 3.1 Goals

- **Accurate, findable image text.** The headline feature: text inside images must be reliably detectable via `Ctrl+F`. This is the project's top priority.
- **Faithful rendering.** The PDF must look like a PDF — crisp on high-DPI screens, fit to the window, not like a low-resolution scan.
- **Native search experience.** Searching, highlighting, and match-to-match navigation should feel built-in.
- **Responsiveness at scale.** Large PDFs must remain usable — opening, scrolling, and searching should never block on full-document processing.
- **Offline and private.** No network calls; OCR and language models run entirely on-device.
- **Selectable and copyable text.** Users must be able to select and copy text, and what they copy must match what they see.

### 3.2 The read-only constraint

> **Hard constraint — the original PDF is never modified.** The solution is strictly **read-only render + overlay**. The extension renders a faithful view of the file and lays an invisible text layer *on top*; it never rewrites, re-encodes, or changes the format of the source document in any way. Every architectural decision respects this boundary.

This constraint is the reason we build a custom viewer at all (Section 5) and the reason OCR output is stored separately in a cache (Section 8.6) rather than written back into the document.

### 3.3 Non-goals

- Editing, annotating, or re-saving PDFs.
- Server-side or cloud OCR (everything is on-device by design).
- Perfect OCR. OCR is inherently imperfect; the system is designed to *maximise findability despite* recognition errors (see correction variants, Section 8.7) rather than to guarantee character-perfect transcription.
- Searching arbitrary images on ordinary web pages (the content script is a stub reserved for a future phase).
