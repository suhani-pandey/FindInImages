# 🔍 Searchable PDFs & Images (Ctrl+F Anywhere)

A Chrome extension that makes **scanned PDFs and image-based documents searchable using native Ctrl+F** by applying OCR and injecting a hidden text layer into the DOM.

---

## ✨ Overview

Most PDFs and images fall into two categories:

* ✅ Text-based (already searchable)
* ❌ Scanned PDFs / images (not searchable)

This extension bridges that gap by using **OCR + DOM text injection** to make all content searchable using the browser’s built-in **Ctrl+F** functionality.

Instead of building a custom search system, it **transforms documents so the browser can search them natively**.

---

## 🚀 Features

* 🔎 Search scanned PDFs using **Ctrl+F**
* 🧠 Automatic detection of text vs image-based pages
* 📄 Full PDF rendering using PDF.js
* 🤖 OCR support for image-based pages (Tesseract.js)
* ⚡ Web Worker-based processing (non-blocking UI)
* 🧱 Invisible DOM text layer overlay
* 💾 IndexedDB caching for processed documents
* 🔄 Page-by-page incremental processing
* 🖼️ Support for image-based content inside PDFs

---

## 🧩 Tech Stack

### Core

* JavaScript (ES6+)
* HTML5 / CSS3
* Chrome Extension (Manifest V3)

### PDF Processing

* PDF.js (Mozilla)

  * Rendering PDF pages
  * Extracting text content
  * Viewport & scaling system

### OCR Engine

* Tesseract.js

  * Client-side OCR
  * Word-level bounding boxes
* Web Workers

  * Background OCR processing

### Data & Storage

* IndexedDB

  * OCR result caching
  * Prevents redundant processing

### Rendering System

* Canvas API (via PDF.js)
* Custom DOM Text Layer

  * Invisible `<span>` overlays
  * Enables native browser search

### Chrome Integration

* Content Scripts
* Service Worker (MV3)
* Request interception (PDF routing to custom viewer)

---

## 🏗️ Architecture

The system follows a pipeline architecture that converts PDF/image content into searchable DOM text.

```text id="v8p3x1"
PDF Request
   ↓
Chrome Extension Interception
   ↓
Custom PDF Viewer (PDF.js)
   ↓
Page Rendering (Canvas)
   ↓
Text Exists?
   ├── Yes → Extract via PDF.js text layer
   └── No → OCR (Tesseract.js Worker)
                 ↓
        Bounding Box + Text Output
                 ↓
     Coordinate Transformation Engine
                 ↓
   Invisible DOM Text Layer Injection
                 ↓
        Native Browser Ctrl+F Search
```

---

### 🔧 Coordinate System Mapping

A key challenge is aligning OCR output with rendered PDF pages:

```text id="c9m2qz"
PDF Space (points, bottom-left origin)
   ↓
PDF.js Viewport
   ↓
Canvas Space (pixels)
   ↓
DOM Overlay Space (top-left origin)
```

This system ensures OCR text aligns precisely with the visual content across:

* zoom levels
* scaling
* different resolutions

---

### 🧱 Core Pipeline

Each page goes through:

1. **Text Detection**

   * Use PDF.js `getTextContent()`
   * Skip OCR if possible

2. **OCR Processing (if needed)**

   * Run Tesseract.js in Web Worker
   * Extract text + bounding boxes

3. **Normalization**

   * Standardize coordinates
   * Map OCR output to page layout

4. **DOM Injection**

   * Create invisible `<span>` elements
   * Position them over the canvas

5. **Browser Search Integration**

   * Ctrl+F works naturally via DOM text

---

## ⚙️ How It Works

Instead of implementing a custom search engine, this extension:

> Converts non-searchable content into real DOM text so the browser can handle search natively.

This avoids reinventing:

* search indexing
* highlight logic
* query parsing

---

## 📦 Installation

```bash id="h2kq9a"
git clone https://github.com/your-username/searchable-pdfs.git
```

1. Open Chrome
2. Go to:

   ```
   chrome://extensions/
   ```
3. Enable **Developer Mode**
4. Click **Load unpacked**
5. Select the project folder

---

## 🧪 Usage

1. Open any PDF in Chrome
2. The extension loads the custom viewer
3. Wait for processing (OCR if needed)
4. Press:

```text id="k1p0ld"
Ctrl + F
```

5. Search normally 🎉

---

## ⚡ Performance Strategy

* **Lazy Processing** → Only process required pages
* **Web Workers** → OCR runs off main thread
* **Incremental Rendering** → Pages become searchable progressively
* **IndexedDB Caching** → Avoid repeated OCR runs

---

## 🧠 Key Engineering Challenges

### 🔴 Coordinate Mapping Complexity

Mapping OCR output to rendered PDF required synchronizing:

* PDF coordinate space
* canvas rendering space
* DOM layout space
* zoom and scaling factors

---

### 🔴 Native Ctrl+F Integration

Instead of intercepting search:

* Real DOM text nodes are injected
* Browser handles search automatically

---

### 🔴 OCR Performance

OCR is CPU-heavy:

* solved with Web Workers
* progressive page processing
* caching system

---

### 🔴 OCR Accuracy

OCR may produce imperfect results:

* misread characters can affect search results
* example: `"hello"` → `"he11o"`

---

## 📊 Project Scope

| Component                    | Complexity |
| ---------------------------- | ---------- |
| PDF rendering                | Medium     |
| OCR pipeline                 | Medium     |
| Coordinate mapping           | High       |
| DOM overlay system           | High       |
| Chrome extension integration | Medium     |

---

## ⏱️ Estimated Development Time

* Core MVP: 50–80 hours
* Part-time build: 8–12 weeks
* Focused sprint: 2–3 weeks

---

## 🛣️ Roadmap

* [ ] Improve OCR accuracy (post-processing)
* [ ] Better handling of rotated pages
* [ ] Multi-language OCR support
* [ ] Performance optimizations for large PDFs
* [ ] GPU/WebAssembly acceleration
* [ ] Preprocessing entire documents in background

---

## ⚠️ Limitations

* OCR is not 100% accurate
* Large PDFs may take time to process
* Complex layouts may cause slight misalignment
* Performance depends on device capabilities

---

## 🙌 Acknowledgements

* Mozilla PDF.js
* Tesseract.js OCR engine

---

## 💡 Why This Project Matters

This project demonstrates how to:

* bridge OCR systems with browser rendering
* integrate low-level coordinate mapping
* leverage native browser capabilities instead of reinventing them
* build a real-world Chrome extension with non-trivial architecture

It turns static documents into **fully searchable web-native experiences**.
