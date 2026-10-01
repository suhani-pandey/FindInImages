## 4 Functionalities & User Stories

The behaviour is best understood as a set of user stories, each mapped to the capability that satisfies it.

| User story | How the system satisfies it |
| --- | --- |
| **As a user**, I want `Ctrl+F` to find words that are part of an image. | Image pages are OCR'd and the words are written into a copy of the PDF as invisible text that Chrome's own find matches and highlights (7.3–7.5). |
| **As a user**, I want everything to look and work exactly as before. | The copy is shown in Chrome's native viewer; invisible text paints nothing; the tab title stays the same (7.8). |
| **As a user**, I want one gesture to turn it on and off. | `Ctrl+Shift+F` or the toolbar icon starts processing; on a copy, the same gesture restores the original URL (7.1). |
| **As a user**, I want to know what is happening. | The toolbar badge shows `…`, then a percentage, then `✓`; failures show a red `!` whose tooltip explains why (7.1). |
| **As a user**, I want it to work on any PDF I open — even from links without ".pdf", sites I'm signed in to, or my own files. | Any web or file URL is accepted; the file is re-downloaded with the user's cookies and checked for the `%PDF-` signature (7.2). |
| **As a user** of mixed PDFs, I want image text added without duplicating existing text. | OCR words that the page already contains at the same spot are dropped (7.5). |
| **As a user**, I don't want to re-pay the OCR cost every time. | Recognised words are cached in IndexedDB by a SHA-256 of the file, per OCR language (7.7). |
| **As a non-English user**, I want OCR in my language. | English, Danish, or both, chosen from the toolbar icon's right-click menu; bundled, offline language data (7.4). |
| **As a user** with faint or blurry scans, I still want text found. | Pages are rendered at ~3000 px and passed through a gain-capped contrast stretch and an unsharp mask before OCR (7.4). |
| **As a user**, I don't want an extension that slows my browser down. | OCR runs in a hidden document on a worker pool; workers, copies, and cache entries are released when no longer needed (7.9). |
