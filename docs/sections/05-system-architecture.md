## 5 System Architecture

The extension is a **pipeline** that converts an opaque PDF into searchable DOM text. Conceptually, content flows from a PDF request, through interception and rendering, into a text-detection fork (native text vs. OCR), and finally onto an invisible overlay that the browser searches natively.

### 5.1 Pipeline overview

![Figure 1 — End-to-end pipeline. The fork in the middle is the heart of the system: native text and OCR'd image text are produced independently, then merged onto one overlay.](diagrams/01-pipeline.svg)

### 5.2 Component map

The codebase is organised in four layers: the extension runtime, the custom viewer application, the vendored libraries, and the browser platform APIs they build on.

![Figure 2 — Component map. viewer.js is the orchestrator; thin modules handle text-layer geometry, caching, and OCR clean-up; the heavy lifting is delegated to two vendored libraries that run entirely offline.](diagrams/02-components.svg)
