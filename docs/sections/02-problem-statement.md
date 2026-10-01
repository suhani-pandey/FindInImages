## 2 Problem Statement

PDFs and document images fall into two broad categories:

- **Text-based** — the characters are encoded as text. The browser can already select and search them.
- **Image-based** — scanned pages, photographed documents, screenshots, or "text" that has been flattened into a picture. To a computer these are just coloured pixels: **not selectable, not searchable.**

Chrome's built-in PDF viewer renders image-based PDFs perfectly but cannot find a single word inside them, because there is no text to find. For anyone working with scanned reports, lecture notes, invoices, or archival material, this is a daily friction point: the information is visible but not reachable.

A further subtlety: many real PDFs are **mixed**. A single page may contain native text *and* images that themselves contain text (a scanned figure with a caption, a table rendered as a picture, a logo with a tagline). A useful solution must handle native text, image text, and the two together on the same page — without duplicating words or misaligning them.

And a constraint that shaped the final design: Chrome's PDF viewer is a sealed component. Extensions cannot script it, inject into it, or add a text layer to it. Anything that keeps the native viewer must therefore change the *file* the viewer shows, not the viewer.

> **The problem in one line.** Make the text that lives *inside images* findable through Chrome's native `Ctrl+F`, in Chrome's native viewer, without altering the original file or how it looks.
