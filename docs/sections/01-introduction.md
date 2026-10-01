## 1 Introduction

**Find in Images** is a Chrome (Manifest V3) extension that makes scanned PDFs searchable with **Chrome's own Ctrl+F**. Open a scanned PDF, press `Ctrl+Shift+F`, and a moment later the browser's normal find bar locates words that exist only as pixels inside the page images.

The extension adds **no interface of its own**. It doesn't replace Chrome's PDF viewer, draw overlays, or bring its own find bar. Instead it uses the "searchable scan" technique that document scanners use. It reads the text in the page images with on-device OCR, writes that text into a **copy** of the PDF as an invisible layer, and shows the copy in Chrome's built-in viewer. Because the text is genuinely in the file, Chrome's find, highlighting, selection and copy all work on it unchanged.

> **Design philosophy.** Lean on native browser capabilities instead of reinventing them. We never implement search, highlighting, or a viewer — we make the document searchable and let Chrome do the rest. Everything runs locally; no document ever leaves the machine.

This document explains the problem, the architecture, every technology used and how it is integrated, a walkthrough of the implementation, and the **phase-by-phase reasoning** behind how the system was built. That history includes two reversals: from a custom viewer to an on-demand one, and from any custom viewer to none. It ends with how the extension is tested and released.
