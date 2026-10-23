// Glue between the stock PDF.js viewer and the VS Code extension host.
// Loaded as a module *before* viewer.mjs so the "webviewerloaded" hook is in place.

const vscode = acquireVsCodeApi();
const cfg = JSON.parse(document.getElementById("pdfa-config").textContent);

let app = null;
let suppressDirty = false;
let workerReady = null;
let lastSaveShortcut = 0;
window.addEventListener(
  "keydown",
  (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "s") lastSaveShortcut = Date.now();
  },
  true
);

function post(msg, transfer) {
  vscode.postMessage(msg, transfer);
}

// PDF.js runs its parser in a Web Worker. Webview resources live on a different
// origin than the webview itself, so the worker is started from a blob URL.
function ensureWorker() {
  if (!workerReady) {
    workerReady = (async () => {
      const res = await fetch(cfg.workerUrl);
      if (!res.ok) throw new Error(`Could not load PDF worker (${res.status})`);
      const code = await res.text();
      const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
      const worker = new Worker(url, { type: "module" });
      window.PDFViewerApplicationOptions.set("workerPort", worker);
    })();
  }
  return workerReady;
}

document.addEventListener("webviewerloaded", () => {
  const opts = window.PDFViewerApplicationOptions;
  app = window.PDFViewerApplication;

  opts.set("disablePreferences", true);
  opts.set("defaultUrl", "");
  opts.set("disableHistory", true);
  opts.set("enableScripting", false);
  opts.set("isEvalSupported", false);
  // Fetch cMaps / fonts / wasm on the main thread (the webview's resource loader).
  opts.set("useWorkerFetch", false);
  opts.set("cMapUrl", cfg.cMapUrl);
  opts.set("standardFontDataUrl", cfg.standardFontDataUrl);
  opts.set("wasmUrl", cfg.wasmUrl);
  opts.set("iccUrl", cfg.iccUrl);
  opts.set("viewerCssTheme", cfg.dark ? 2 : 1);
  // Sidebar starts hidden, even for PDFs that ask to open with their outline.
  opts.set("sidebarViewOnLoad", 0);
  // Annotation tools.
  opts.set("enableComment", true);
  opts.set("enableSignatureEditor", true);
  opts.set("enableHighlightFloatingButton", true);
  opts.set("enableAltText", false);
  opts.set("enableNewAltTextWhenAddingImage", false);
  opts.set("enableAltTextModelDownload", false);

  // Toolbar "Save" button -> save through VS Code (writes the file). Ctrl/Cmd+S
  // is already handled by VS Code's own keybinding, so don't save twice.
  app.downloadOrSave = async () => {
    if (Date.now() - lastSaveShortcut < 1000) return;
    post({ type: "requestSave" });
  };

  // Report the first unsaved change so VS Code shows the editor as dirty.
  const origInit = app._initializeAnnotationStorageCallbacks;
  app._initializeAnnotationStorageCallbacks = function (pdfDocument) {
    origInit.call(this, pdfDocument);
    if (pdfDocument !== this.pdfDocument) return;
    const storage = pdfDocument.annotationStorage;
    const origSet = storage.onSetModified;
    storage.onSetModified = () => {
      origSet?.();
      if (!suppressDirty) post({ type: "dirty" });
    };
  };
});

async function captureView() {
  const v = app?.pdfViewer;
  if (!app?.pdfDocument || !v) return null;
  return {
    scale: v.currentScaleValue,
    top: v.container.scrollTop,
    left: v.container.scrollLeft,
    sidebar: (() => { const s = app.viewsManager ?? app.pdfSidebar; return s?.isOpen ? s.visibleView : null; })(),
  };
}

function restoreView(view) {
  if (!view) return;
  const v = app.pdfViewer;
  const apply = () => {
    v.currentScaleValue = view.scale;
    requestAnimationFrame(() => {
      v.container.scrollTop = view.top;
      v.container.scrollLeft = view.left;
    });
  };
  // Let the viewer apply its own initial view first, then override it.
  app.eventBus.on("pagesloaded", () => setTimeout(apply, 0), { once: true });
}

// VS Code may deliver binary data as a Uint8Array from another realm, an
// ArrayBuffer, a DataView-like view, or (older hosts) a plain indexed object.
function toUint8(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const tag = Object.prototype.toString.call(data);
  if (tag === "[object Uint8Array]" || tag === "[object ArrayBuffer]") return new Uint8Array(data);
  if (data && typeof data === "object") {
    if (Array.isArray(data.data)) return Uint8Array.from(data.data); // {type:"Buffer",data:[..]}
    const n = typeof data.length === "number" ? data.length : Object.keys(data).length;
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = data[i];
    return out;
  }
  throw new Error("No PDF data received");
}

async function load({ data, filename, preserveView, dirty }) {
  data = toUint8(data);
  await app.initializedPromise;
  await ensureWorker();
  const view = preserveView ? await captureView() : null;
  // On a reload keep the sidebar as the user left it; otherwise start hidden.
  window.PDFViewerApplicationOptions.set("sidebarViewOnLoad", view?.sidebar ?? 0);
  restoreView(view);
  suppressDirty = true;
  try {
    await app.open({ data, filename });
  } finally {
    suppressDirty = false;
  }
  const doc = app.pdfDocument;
  if (dirty && doc) {
    // Content we loaded is not what is on disk (e.g. re-applied annotations).
    post({ type: "dirty" });
  }
  post({ type: "loaded", numPages: doc?.numPages ?? 0 });
}

async function getData() {
  const doc = app.pdfDocument;
  if (!doc) throw new Error("No document loaded");
  // Commit an annotation that is still being typed/drawn.
  try {
    app.pdfViewer?._layerProperties?.annotationEditorUIManager?.endCurrentEditing?.();
  } catch {}
  await app.pdfScriptingManager?.dispatchWillSave?.();
  const data = doc.annotationStorage.size > 0 ? await doc.saveDocument() : await doc.getData();
  return data;
}

window.addEventListener("message", async (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== "object") return;
  try {
    switch (msg.type) {
      case "load":
        await load(msg);
        break;
      case "getData": {
        const data = await getData();
        post({ type: "data", requestId: msg.requestId, data });
        break;
      }
      case "markSaved":
        app.pdfDocument?.annotationStorage.resetModified();
        break;
    }
  } catch (err) {
    const message = String(err?.message || err);
    if (msg.requestId !== undefined) {
      post({ type: "data", requestId: msg.requestId, error: message });
    } else {
      post({ type: "error", message });
    }
  }
});

// ---------------------------------------------------------------------------
// SyncTeX reverse search: Ctrl/Cmd+click a spot to jump to the LaTeX source.
// ---------------------------------------------------------------------------

/** The word under the pointer, from PDF.js's text layer (works in every tool mode). */
function wordAt(pageDiv, clientX, clientY) {
  for (const span of pageDiv.querySelectorAll(".textLayer span")) {
    if (span.children.length) continue;
    const r = span.getBoundingClientRect();
    if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) continue;
    const text = span.textContent || "";
    if (!text.trim() || !r.width) return undefined;
    let i = Math.min(text.length - 1, Math.max(0, Math.floor(((clientX - r.left) / r.width) * text.length)));
    const isWord = (ch) => /[\p{L}\p{N}_'-]/u.test(ch);
    if (!isWord(text[i])) return undefined;
    let a = i;
    let b = i;
    while (a > 0 && isWord(text[a - 1])) a--;
    while (b < text.length - 1 && isWord(text[b + 1])) b++;
    return text.slice(a, b + 1);
  }
  return undefined;
}

let suppressClickUntil = 0;

function onSyncPointer(e) {
  if (!(e.ctrlKey || e.metaKey) || e.button !== 0 || !app?.pdfDocument) return;
  const pageDiv = e.target.closest?.(".page[data-page-number]");
  if (!pageDiv) return;
  // Leave Ctrl/Cmd+click on an existing annotation to PDF.js (multi-select).
  if (e.target.closest(".annotationEditorLayer > div")) return;

  const pageNumber = Number(pageDiv.dataset.pageNumber);
  const pageView = app.pdfViewer.getPageView(pageNumber - 1);
  const surface = pageDiv.querySelector(".canvasWrapper") || pageDiv;
  const rect = surface.getBoundingClientRect();
  if (!pageView?.viewport || !rect.width) return;

  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
  suppressClickUntil = Date.now() + 600;

  const [px, py] = pageView.viewport.convertToPdfPoint(e.clientX - rect.left, e.clientY - rect.top);
  const [x0, , , y1] = pageView.viewport.viewBox;
  post({
    type: "syncTexEdit",
    page: pageNumber,
    x: px - x0, // SyncTeX measures from the page's top-left corner, in big points
    y: y1 - py,
    word: wordAt(pageDiv, e.clientX, e.clientY),
  });
}

window.addEventListener("pointerdown", onSyncPointer, true);
window.addEventListener("mousedown", (e) => {
  if (Date.now() < suppressClickUntil && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }
}, true);
window.addEventListener("click", (e) => {
  // Swallow the click that follows (so a link under the cursor isn't followed).
  if (Date.now() < suppressClickUntil) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }
}, true);

// Tell the host we're listening once the viewer UI is initialized.
(async function waitForApp() {
  while (!window.PDFViewerApplication) await new Promise((r) => setTimeout(r, 20));
  await window.PDFViewerApplication.initializedPromise;
  post({ type: "ready" });
})();
