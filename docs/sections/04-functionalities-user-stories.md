## 4 Functionalities & User Stories

The behaviour is best understood as a set of user stories, each mapped to the capability that satisfies it.

| User story | How the system satisfies it |
| --- | --- |
| **As a user**, when I open a PDF link, I want it to open in a viewer that can search image text — automatically, with no extra clicks. | A Manifest V3 service worker installs a `declarativeNetRequest` rule that transparently redirects every `.pdf` navigation to the bundled viewer (8.1). |
| **As a user**, I want the document to look sharp and fit my window, not zoomed or pixelated. | PDF.js renders each page fit-to-width, with a device-pixel-ratio–scaled canvas backing store for crisp HiDPI output (8.2, 8.4). |
| **As a user**, I want to press `Ctrl+F` and find words that are part of an image. | Image regions are OCR'd with Tesseract.js and the recognised words are injected as an invisible, aligned text layer that native find can match (8.3, 8.7). |
| **As a user**, I want to jump between matches and see the active one clearly, even on colourful pages. | A custom find bar draws translucent highlight boxes with a distinct, pulsing active match, navigable by the up/down buttons, Enter/Shift+Enter, F3, or arrow keys (8.7, 11). |
| **As a user**, I want to select and copy text, and have the copied text match what I see. | Text spans are measured and horizontally scaled to the exact glyph width, so selection ranges and clipboard output line up with the rendering (9). |
| **As a user** with a long PDF, I don't want to wait for the whole file before I can scroll or search. | Pages render lazily as they approach the viewport; the rest are indexed in the background during idle time across parallel OCR workers (12). |
| **As a user**, I don't want to re-pay the OCR cost every time I reopen the same document. | Recognised words are cached in IndexedDB, scoped per document *and* per OCR language, with a format version for safe invalidation (8.6). |
| **As a non-English user**, I want OCR in my language. | A language selector (English, Danish, or both) drives Tesseract with bundled, offline trained data; results are cached independently per language (8.3). |
| **As a user** with a scanned document that has faint or blurry text, I still want it found. | Before OCR, each region is rendered at ~360 DPI and passed through a contrast stretch + unsharp mask to recover low-contrast and blurred glyphs (8.5). |
