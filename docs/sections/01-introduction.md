## 1 Introduction

**Find in Images** is a Chrome (Manifest V3) extension that makes *any* PDF behave like a real, searchable web page — including scanned documents and PDFs whose text lives inside pictures. When you open a PDF and press `Ctrl+F`, the browser's own find feature locates words that are physically part of an image, not just selectable text.

The core idea is deliberately conservative: rather than building a bespoke search engine, the extension **transforms the document into something the browser already knows how to search**. It renders each page, recognises the text inside images with on-device OCR, and injects that text back into the page as invisible, precisely-positioned DOM elements. The browser's native find then "just works", complete with its familiar highlighting and match navigation.

> **Design philosophy.** Lean on native browser capabilities instead of reinventing them. We never implement search indexing, query parsing, or highlight logic — we make the content searchable and let Chrome do the rest. Everything runs locally; no document ever leaves the machine.

This document explains the problem, the architecture, every technology used and exactly how it is integrated, a walkthrough of the implementation, and — importantly — the **phase-by-phase reasoning** behind how the system was built, including what each phase set out to solve and why it led naturally to the next.
