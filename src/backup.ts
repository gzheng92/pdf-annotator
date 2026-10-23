import { createHash } from "crypto";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import type { AnnotationInfo } from "./annotations";

export interface BackupInfo {
  dir: string;
  createdAt: Date;
  annotatedPdf: string;
  annotationCount: number;
}

export function defaultBackupRoot(): string {
  return path.join(os.tmpdir(), "vscode-pdf-annotator");
}

export function hashBytes(bytes: Uint8Array): string {
  return createHash("sha1").update(bytes).digest("hex");
}

function stemOf(pdfPath: string): string {
  return path.basename(pdfPath).replace(/\.pdf$/i, "");
}

/** One folder per source PDF, e.g. `paper-1a2b3c4d`, so same-named files don't collide. */
export function backupDirFor(root: string, pdfPath: string): string {
  const safe = stemOf(pdfPath).replace(/[^\w.-]+/g, "_").slice(0, 60) || "document";
  const id = createHash("sha1").update(path.resolve(pdfPath)).digest("hex").slice(0, 8);
  return path.join(root, `${safe}-${id}`);
}

function timestamp(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_` +
    `${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`
  );
}

/**
 * Writes `<root>/<file>-<id>/<timestamp>/` containing:
 *  - `<name>.annotated.pdf`  the PDF as it looked in the editor, annotations included
 *  - `<name>.previous.pdf`   the file as it was on disk before being overwritten (if different)
 *  - `annotations.json`      a readable list of the annotations
 */
export async function writeBackup(opts: {
  root: string;
  pdfPath: string;
  annotatedBytes: Uint8Array;
  previousDiskBytes: Uint8Array;
  annotations: AnnotationInfo[];
  maxBackups: number;
}): Promise<BackupInfo> {
  const createdAt = new Date();
  const fileDir = backupDirFor(opts.root, opts.pdfPath);
  const dir = path.join(fileDir, timestamp(createdAt));
  await fs.mkdir(dir, { recursive: true });

  const stem = stemOf(opts.pdfPath);
  const annotatedPdf = path.join(dir, `${stem}.annotated.pdf`);
  await fs.writeFile(annotatedPdf, opts.annotatedBytes);
  if (hashBytes(opts.previousDiskBytes) !== hashBytes(opts.annotatedBytes)) {
    await fs.writeFile(path.join(dir, `${stem}.previous.pdf`), opts.previousDiskBytes);
  }
  await fs.writeFile(
    path.join(dir, "annotations.json"),
    JSON.stringify(
      {
        source: opts.pdfPath,
        backedUpAt: createdAt.toISOString(),
        annotationCount: opts.annotations.length,
        annotations: opts.annotations,
      },
      null,
      2
    )
  );

  await prune(fileDir, opts.maxBackups);
  return { dir, createdAt, annotatedPdf, annotationCount: opts.annotations.length };
}

/** Backups for one PDF, newest first. */
export async function listBackups(root: string, pdfPath: string): Promise<BackupInfo[]> {
  const fileDir = backupDirFor(root, pdfPath);
  let names: string[];
  try {
    names = await fs.readdir(fileDir);
  } catch {
    return [];
  }
  const out: BackupInfo[] = [];
  for (const name of names.sort().reverse()) {
    const dir = path.join(fileDir, name);
    try {
      const meta = JSON.parse(await fs.readFile(path.join(dir, "annotations.json"), "utf8"));
      const pdf = (await fs.readdir(dir)).find((f) => f.endsWith(".annotated.pdf"));
      if (!pdf) continue;
      out.push({
        dir,
        createdAt: new Date(meta.backedUpAt),
        annotatedPdf: path.join(dir, pdf),
        annotationCount: meta.annotationCount ?? 0,
      });
    } catch {
      // not a backup folder
    }
  }
  return out;
}

async function prune(fileDir: string, maxBackups: number) {
  const names = (await fs.readdir(fileDir)).sort().reverse();
  for (const name of names.slice(Math.max(1, maxBackups))) {
    await fs.rm(path.join(fileDir, name), { recursive: true, force: true });
  }
}
