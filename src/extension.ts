import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { copyAnnotations, listAnnotations } from "./annotations";
import { buildViewerHtml } from "./html";
import { findSyncTexFile, loadSyncTex, reverseLookup } from "./synctex";
import { BackupInfo, defaultBackupRoot, hashBytes, listBackups, writeBackup } from "./backup";

const VIEW_TYPE = "pdfAnnotator.editor";

// ---------------------------------------------------------------------------
// Webview wrapper
// ---------------------------------------------------------------------------

class PdfWebview {
  private nextId = 1;
  private pending = new Map<number, { resolve: (b: Uint8Array) => void; reject: (e: Error) => void }>();
  private readyResolve!: () => void;
  readonly ready = new Promise<void>((r) => (this.readyResolve = r));

  constructor(readonly panel: vscode.WebviewPanel) {}

  markReady() {
    this.readyResolve();
  }

  async load(data: Uint8Array, filename: string, opts: { preserveView?: boolean; dirty?: boolean } = {}) {
    await this.ready;
    await this.panel.webview.postMessage({ type: "load", data, filename, ...opts });
  }

  /** The PDF exactly as shown, including annotations not yet saved. */
  async getData(timeoutMs = 30000): Promise<Uint8Array> {
    await this.ready;
    const requestId = this.nextId++;
    return new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Timed out waiting for the PDF viewer"));
      }, timeoutMs);
      this.pending.set(requestId, {
        resolve: (b) => (clearTimeout(timer), resolve(b)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.panel.webview.postMessage({ type: "getData", requestId });
    });
  }

  settle(requestId: number, data?: unknown, error?: string) {
    const p = this.pending.get(requestId);
    if (!p) return;
    this.pending.delete(requestId);
    if (error) p.reject(new Error(error));
    else p.resolve(toBytes(data));
  }

  markSaved() {
    this.panel.webview.postMessage({ type: "markSaved" });
  }

  dispose() {
    for (const p of this.pending.values()) p.reject(new Error("Editor closed"));
    this.pending.clear();
  }
}

function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data && typeof data === "object") {
    const o = data as { data?: unknown; length?: number } & Record<number, number>;
    if (Array.isArray(o.data)) return Uint8Array.from(o.data as number[]);
    const n = typeof o.length === "number" ? o.length : Object.keys(o).length;
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = o[i];
    return out;
  }
  throw new Error("Viewer returned no data");
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

class PdfDocument implements vscode.CustomDocument {
  webview?: PdfWebview;
  /** Content we believe is on disk (to tell our own writes from other programs'). */
  diskBytes: Uint8Array;
  diskHash: string;
  dirty = false;
  private watcher?: vscode.FileSystemWatcher;
  private debounce?: NodeJS.Timeout;
  private checking = false;
  private recheck = false;

  constructor(
    readonly uri: vscode.Uri,
    readonly initialBytes: Uint8Array,
    diskBytes: Uint8Array,
    readonly initiallyDirty: boolean,
    private readonly onExternalChange: (doc: PdfDocument, newBytes: Uint8Array) => Promise<void>
  ) {
    this.diskBytes = diskBytes;
    this.diskHash = hashBytes(diskBytes);
    this.watch();
  }

  get fileName() {
    return path.basename(this.uri.path);
  }

  setDisk(bytes: Uint8Array) {
    this.diskBytes = bytes;
    this.diskHash = hashBytes(bytes);
  }

  async currentBytes(): Promise<Uint8Array> {
    return this.webview ? this.webview.getData() : this.diskBytes;
  }

  private watch() {
    const dir = vscode.Uri.joinPath(this.uri, "..");
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(dir, path.basename(this.uri.path))
    );
    const schedule = () => this.schedule();
    this.watcher.onDidChange(schedule);
    this.watcher.onDidCreate(schedule);
    // Many tools (LaTeX, pandoc) delete and recreate the file; wait for it to return.
    this.watcher.onDidDelete(() => this.schedule(1500));
    // VS Code's watcher can miss changes (files outside the workspace, network
    // drives, some editors' atomic renames), so also poll the file's mtime.
    if (this.uri.scheme === "file") {
      this.pollListener = (cur, prev) => {
        if (cur.mtimeMs !== prev.mtimeMs || cur.size !== prev.size) this.schedule();
      };
      fs.watchFile(this.uri.fsPath, { interval: 1000, persistent: false }, this.pollListener);
    }
  }
  private pollListener?: (cur: fs.Stats, prev: fs.Stats) => void;

  recheckSoon(delay = 400) {
    this.schedule(delay);
  }

  private schedule(delay = 400) {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.check(), delay);
  }

  private async check() {
    if (this.checking) {
      this.recheck = true;
      return;
    }
    this.checking = true;
    try {
      const bytes = await readCompletePdf(this.uri);
      if (!bytes) {
        log(`${this.uri.fsPath} changed but never became a complete PDF; ignoring.`);
        return;
      }
      if (hashBytes(bytes) === this.diskHash) return;
      log(`${this.uri.fsPath} was changed by another program (${bytes.length} bytes).`);
      await this.onExternalChange(this, bytes);
    } catch (err) {
      log(`External change handling failed for ${this.uri.fsPath}: ${errMsg(err)}`);
    } finally {
      this.checking = false;
      if (this.recheck) {
        this.recheck = false;
        this.schedule();
      }
    }
  }

  dispose() {
    clearTimeout(this.debounce);
    this.watcher?.dispose();
    if (this.pollListener) fs.unwatchFile(this.uri.fsPath, this.pollListener);
    this.webview?.dispose();
  }
}

/** Waits until a PDF that another program is writing looks complete and stable. */
async function readCompletePdf(uri: vscode.Uri, attempts = 30): Promise<Uint8Array | undefined> {
  let previous: Uint8Array | undefined;
  for (let i = 0; i < attempts; i++) {
    let bytes: Uint8Array | undefined;
    try {
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch {
      bytes = undefined; // missing for now
    }
    if (bytes && looksComplete(bytes) && previous && sameBytes(previous, bytes)) return bytes;
    previous = bytes;
    await new Promise((r) => setTimeout(r, i === 0 ? 150 : 400));
  }
  return previous && looksComplete(previous) ? previous : undefined;
}

function looksComplete(b: Uint8Array): boolean {
  if (b.length < 64) return false;
  const head = Buffer.from(b.subarray(0, 1024)).toString("latin1");
  const tail = Buffer.from(b.subarray(Math.max(0, b.length - 2048))).toString("latin1");
  return head.includes("%PDF-") && tail.includes("%%EOF");
}

function sameBytes(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && Buffer.from(a).equals(Buffer.from(b));
}

// ---------------------------------------------------------------------------
// Editor provider
// ---------------------------------------------------------------------------

class PdfEditorProvider implements vscode.CustomEditorProvider<PdfDocument> {
  private readonly changeEmitter = new vscode.EventEmitter<vscode.CustomDocumentContentChangeEvent<PdfDocument>>();
  readonly onDidChangeCustomDocument = this.changeEmitter.event;

  activeDocument?: PdfDocument;

  constructor(private readonly context: vscode.ExtensionContext) {}

  // --- lifecycle -----------------------------------------------------------

  async openCustomDocument(uri: vscode.Uri, openContext: vscode.CustomDocumentOpenContext): Promise<PdfDocument> {
    const diskBytes = await vscode.workspace.fs.readFile(uri);
    let initial = diskBytes;
    let dirty = false;
    if (openContext.backupId) {
      try {
        initial = await vscode.workspace.fs.readFile(vscode.Uri.parse(openContext.backupId));
        dirty = true;
      } catch {
        // backup gone; fall back to disk
      }
    }
    return new PdfDocument(uri, initial, diskBytes, dirty, (doc, bytes) => this.handleOverwrite(doc, bytes));
  }

  async resolveCustomEditor(document: PdfDocument, panel: vscode.WebviewPanel): Promise<void> {
    const media = vscode.Uri.joinPath(this.context.extensionUri, "media");
    panel.webview.options = { enableScripts: true, localResourceRoots: [media] };
    panel.webview.html = this.html(panel.webview);

    const view = new PdfWebview(panel);
    document.webview = view;
    if (panel.active) this.activeDocument = document;

    panel.onDidChangeViewState(() => {
      if (panel.active) this.activeDocument = document;
      else if (this.activeDocument === document) this.activeDocument = undefined;
    });
    panel.onDidDispose(() => {
      if (document.webview === view) document.webview = undefined;
      if (this.activeDocument === document) this.activeDocument = undefined;
      view.dispose();
    });

    panel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg?.type) {
        case "ready":
          view.markReady();
          view.load(document.initialBytes, document.fileName, { dirty: document.initiallyDirty });
          break;
        case "dirty":
          this.markDirty(document);
          break;
        case "data":
          view.settle(msg.requestId, msg.data, msg.error);
          break;
        case "requestSave":
          if (panel.active) await vscode.commands.executeCommand("workbench.action.files.save");
          break;
        case "syncTexEdit":
          await reverseSearch(document.uri, panel, msg);
          break;
        case "error":
          vscode.window.showErrorMessage(`PDF Annotator: ${msg.message}`);
          break;
      }
    });
  }

  private markDirty(document: PdfDocument) {
    document.dirty = true;
    this.changeEmitter.fire({ document });
  }

  // --- save / revert / backup ---------------------------------------------

  async saveCustomDocument(document: PdfDocument): Promise<void> {
    // Never overwrite a file another program just wrote (e.g. auto-save firing
    // right after a LaTeX rebuild). Back up + reload is handled by the watcher.
    let onDisk: Uint8Array | undefined;
    try {
      onDisk = await vscode.workspace.fs.readFile(document.uri);
    } catch {
      onDisk = undefined; // deleted: saving recreates it
    }
    if (onDisk && hashBytes(onDisk) !== document.diskHash) {
      log(`Skipped saving ${document.uri.fsPath}: it was changed by another program.`);
      document.recheckSoon(0);
      return;
    }

    const bytes = await document.currentBytes();
    document.setDisk(bytes); // set first so the watcher ignores our own write
    await vscode.workspace.fs.writeFile(document.uri, bytes);
    document.dirty = false;
    document.webview?.markSaved();
  }

  async saveCustomDocumentAs(document: PdfDocument, destination: vscode.Uri): Promise<void> {
    const bytes = await document.currentBytes();
    await vscode.workspace.fs.writeFile(destination, bytes);
  }

  async revertCustomDocument(document: PdfDocument): Promise<void> {
    const bytes = await vscode.workspace.fs.readFile(document.uri);
    document.setDisk(bytes);
    document.dirty = false;
    await document.webview?.load(bytes, document.fileName, { preserveView: true });
  }

  async backupCustomDocument(
    document: PdfDocument,
    context: vscode.CustomDocumentBackupContext
  ): Promise<vscode.CustomDocumentBackup> {
    const bytes = await document.currentBytes();
    await vscode.workspace.fs.writeFile(context.destination, bytes);
    return {
      id: context.destination.toString(),
      delete: () => vscode.workspace.fs.delete(context.destination).then(undefined, () => undefined),
    };
  }

  // --- overwritten on disk --------------------------------------------------

  private async handleOverwrite(document: PdfDocument, newBytes: Uint8Array) {
    const previousDisk = document.diskBytes;
    let annotated = previousDisk;
    try {
      if (document.webview) annotated = await document.webview.getData(15000);
    } catch (err) {
      log(`Could not read annotations from viewer: ${errMsg(err)}`);
    }

    let annotations: Awaited<ReturnType<typeof listAnnotations>> = [];
    try {
      annotations = await listAnnotations(annotated);
    } catch (err) {
      log(`Could not parse annotations: ${errMsg(err)}`);
    }

    let backup: BackupInfo | undefined;
    if (annotations.length > 0) {
      try {
        backup = await writeBackup({
          root: backupRoot(),
          pdfPath: document.uri.fsPath,
          annotatedBytes: annotated,
          previousDiskBytes: previousDisk,
          annotations,
          maxBackups: config().get<number>("maxBackupsPerFile", 20),
        });
      } catch (err) {
        vscode.window.showErrorMessage(`PDF Annotator: could not back up annotations: ${errMsg(err)}`);
      }
    }

    log(`Found ${annotations.length} annotation(s); backup: ${backup?.dir ?? "none"}`);
    document.setDisk(newBytes);
    const mode = config().get<string>("onOverwrite", "ask");

    if (!backup) {
      // Nothing of ours to protect: behave like a live preview.
      await this.showDiskVersion(document, newBytes);
      return;
    }

    if (mode === "reapply") {
      const applied = await this.applyAnnotations(document, backup.annotatedPdf, newBytes);
      if (applied) {
        this.notifyBackup(
          document,
          `${document.fileName} changed on disk. Re-applied ${applied} annotation(s); press Save to keep them in the file.`,
          backup,
          false
        );
        return;
      }
      await this.showDiskVersion(document, newBytes);
      return;
    }

    await this.showDiskVersion(document, newBytes);
    this.notifyBackup(
      document,
      `${document.fileName} was overwritten. Your ${backup.annotationCount} annotation(s) were backed up.`,
      backup,
      mode === "ask"
    );
  }

  private async showDiskVersion(document: PdfDocument, bytes: Uint8Array) {
    await document.webview?.load(bytes, document.fileName, { preserveView: true });
    if (document.dirty && this.activeDocument === document) {
      // The unsaved edits now live in the backup; clear the dirty marker.
      await vscode.commands.executeCommand("workbench.action.files.revert");
    }
  }

  private async notifyBackup(document: PdfDocument, message: string, backup: BackupInfo, offerReapply: boolean) {
    const reapply = "Re-apply Annotations";
    const open = "Show Backup";
    const choice = await vscode.window.showInformationMessage(
      message,
      ...(offerReapply ? [reapply, open] : [open])
    );
    if (choice === open) {
      vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(backup.annotatedPdf));
    } else if (choice === reapply) {
      if (document.webview) {
        const current = await document.currentBytes();
        const n = await this.applyAnnotations(document, backup.annotatedPdf, current);
        if (n !== undefined) {
          vscode.window.showInformationMessage(
            n > 0 ? `Re-applied ${n} annotation(s). Press Save to keep them in the file.` : "Those annotations are already in this PDF."
          );
        }
      }
    }
  }

  /** Copies annotations from a backup onto `targetBytes` and shows the result (unsaved). */
  async applyAnnotations(
    document: PdfDocument,
    annotatedPdfPath: string,
    targetBytes: Uint8Array
  ): Promise<number | undefined> {
    try {
      const source = await fs.promises.readFile(annotatedPdfPath);
      const result = await copyAnnotations(source, targetBytes);
      if (result.copied > 0) {
        await document.webview?.load(result.bytes, document.fileName, { preserveView: true, dirty: true });
        this.markDirty(document);
      }
      if (result.droppedPages > 0) {
        vscode.window.showWarningMessage(
          `${result.droppedPages} annotation(s) were on pages the new PDF no longer has; they remain in the backup.`
        );
      }
      return result.copied;
    } catch (err) {
      vscode.window.showErrorMessage(`PDF Annotator: could not re-apply annotations: ${errMsg(err)}`);
      return undefined;
    }
  }

  // --- HTML -------------------------------------------------------------------

  private viewerTemplate?: string;

  private html(webview: vscode.Webview): string {
    const media = vscode.Uri.joinPath(this.context.extensionUri, "media");
    const web = vscode.Uri.joinPath(media, "pdfjs", "web");
    const u = (uri: vscode.Uri) => webview.asWebviewUri(uri).toString();

    const template = (this.viewerTemplate ??= fs.readFileSync(path.join(web.fsPath, "viewer.html"), "utf8"));

    const kind = vscode.window.activeColorTheme.kind;
    return buildViewerHtml(template, {
      cspSource: webview.cspSource,
      mediaUrl: u(media),
      dark: kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast,
    });
  }
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

let output: vscode.OutputChannel | undefined;
function log(message: string) {
  output?.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
}

function config() {
  return vscode.workspace.getConfiguration("pdfAnnotator");
}

function backupRoot(): string {
  const custom = config().get<string>("backupFolder", "").trim();
  return custom ? custom.replace(/^~(?=$|[\\/])/, os.homedir()) : defaultBackupRoot();
}

// ---------------------------------------------------------------------------
// SyncTeX reverse search
// ---------------------------------------------------------------------------

const flash = vscode.window.createTextEditorDecorationType({
  backgroundColor: new vscode.ThemeColor("editor.findMatchHighlightBackground"),
  isWholeLine: true,
});

/** Paths in .synctex files can come from another machine or a container; try to map them here. */
async function resolveSource(file: string, syncFile: string): Promise<string | undefined> {
  const exists = (p: string) => fs.promises.access(p).then(() => true, () => false);
  if (await exists(file)) return file;
  const parts = file.split(/[\\/]+/).filter(Boolean);
  const base = path.dirname(syncFile);
  for (let i = 0; i < parts.length; i++) {
    for (let up = 0; up <= 3; up++) {
      const candidate = path.join(base, ...Array(up).fill(".."), ...parts.slice(i));
      if (await exists(candidate)) return candidate;
    }
  }
  return undefined;
}

async function reverseSearch(
  pdfUri: vscode.Uri,
  panel: vscode.WebviewPanel,
  msg: { page: number; x: number; y: number; word?: string }
) {
  if (pdfUri.scheme !== "file") return;
  const syncFile = await findSyncTexFile(pdfUri.fsPath);
  if (!syncFile) {
    vscode.window.showInformationMessage(
      `No SyncTeX data next to ${path.basename(pdfUri.fsPath)}. Compile with "-synctex=1" (latexmk: add it to your pdflatex options) to enable jumping to the source.`
    );
    return;
  }
  let location;
  try {
    location = reverseLookup(await loadSyncTex(syncFile), msg.page, msg.x, msg.y);
  } catch (err) {
    log(`SyncTeX lookup failed: ${errMsg(err)}`);
  }
  if (!location) {
    vscode.window.setStatusBarMessage("SyncTeX: nothing found at that spot", 3000);
    return;
  }
  const file = await resolveSource(location.file, syncFile);
  if (!file) {
    vscode.window.showWarningMessage(`SyncTeX points to ${location.file}, which doesn't exist on this machine.`);
    return;
  }
  log(`Reverse search: page ${msg.page} (${msg.x.toFixed(1)}, ${msg.y.toFixed(1)}) -> ${file}:${location.line}`);

  const uri = vscode.Uri.file(file);
  const doc = await vscode.workspace.openTextDocument(uri);
  const lineNo = Math.min(Math.max(location.line - 1, 0), doc.lineCount - 1);
  const text = doc.lineAt(lineNo).text;

  // Put the cursor on the clicked word when it appears on that line.
  let start = doc.lineAt(lineNo).firstNonWhitespaceCharacterIndex;
  let end = start;
  if (msg.word) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${msg.word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "u");
    const m = re.exec(text);
    if (m) {
      start = m.index;
      end = m.index + m[0].length;
    }
  }

  // Reuse the column where the file (or any text file) is already shown; else open beside the PDF.
  const visible = vscode.window.visibleTextEditors;
  const column =
    visible.find((e) => e.document.uri.fsPath === uri.fsPath)?.viewColumn ??
    visible.find((e) => e.viewColumn !== panel.viewColumn)?.viewColumn ??
    vscode.ViewColumn.Beside;
  const editor = await vscode.window.showTextDocument(doc, {
    viewColumn: column,
    selection: new vscode.Range(lineNo, start, lineNo, end),
    preserveFocus: false,
  });
  editor.revealRange(new vscode.Range(lineNo, 0, lineNo, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  editor.setDecorations(flash, [new vscode.Range(lineNo, 0, lineNo, 0)]);
  setTimeout(() => editor.setDecorations(flash, []), 1200);
}

function errMsg(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

export function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel("PDF Annotator");
  context.subscriptions.push(output);
  const provider = new PdfEditorProvider(context);

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      // Keep unsaved annotations alive while the tab is in the background.
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pdfAnnotator.reapplyFromBackup", async () => {
      const doc = provider.activeDocument;
      if (!doc) {
        vscode.window.showWarningMessage("Open a PDF in PDF Annotator first.");
        return;
      }
      const backups = await listBackups(backupRoot(), doc.uri.fsPath);
      if (!backups.length) {
        vscode.window.showInformationMessage(`No annotation backups for ${doc.fileName} yet.`);
        return;
      }
      const pick = await vscode.window.showQuickPick(
        backups.map((b) => ({
          label: b.createdAt.toLocaleString(),
          description: `${b.annotationCount} annotation(s)`,
          backup: b,
        })),
        { placeHolder: `Copy annotations from which backup of ${doc.fileName}?` }
      );
      if (!pick) return;
      const current = await doc.currentBytes();
      const n = await provider.applyAnnotations(doc, pick.backup.annotatedPdf, current);
      if (n !== undefined) {
        vscode.window.showInformationMessage(
          n > 0 ? `Re-applied ${n} annotation(s). Press Save to keep them in the file.` : "Those annotations are already in this PDF."
        );
      }
    }),

    vscode.commands.registerCommand("pdfAnnotator.openBackupFolder", async () => {
      const doc = provider.activeDocument;
      const root = backupRoot();
      const latest = doc ? (await listBackups(root, doc.uri.fsPath))[0] : undefined;
      if (latest) {
        await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(latest.annotatedPdf));
      } else {
        await fs.promises.mkdir(root, { recursive: true });
        await vscode.env.openExternal(vscode.Uri.file(root));
      }
    }),

    vscode.commands.registerCommand("pdfAnnotator.exportAnnotations", async () => {
      const doc = provider.activeDocument;
      if (!doc) {
        vscode.window.showWarningMessage("Open a PDF in PDF Annotator first.");
        return;
      }
      const annotations = await listAnnotations(await doc.currentBytes());
      const target = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.joinPath(doc.uri, "..", doc.fileName.replace(/\.pdf$/i, "") + ".annotations.json"),
        filters: { JSON: ["json"] },
      });
      if (!target) return;
      await vscode.workspace.fs.writeFile(
        target,
        Buffer.from(JSON.stringify({ source: doc.uri.fsPath, annotations }, null, 2))
      );
      vscode.window.showInformationMessage(`Exported ${annotations.length} annotation(s).`);
    })
  );
}

export function deactivate() {}
