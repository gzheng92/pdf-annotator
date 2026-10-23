import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "fs";
import os from "os";
import path from "path";
import { backupDirFor, listBackups, writeBackup } from "../.lib/backup.mjs";

const pdf = (s) => new TextEncoder().encode(`%PDF-1.7 ${s} %%EOF`);

test("writes annotated copy, previous version and JSON; keeps the newest N", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "pdfa-test-"));
  const pdfPath = path.join(os.tmpdir(), "thesis", "paper.pdf");
  for (let i = 0; i < 4; i++) {
    await writeBackup({
      root, pdfPath, maxBackups: 3,
      annotatedBytes: pdf(`annotated ${i}`), previousDiskBytes: pdf("on disk"),
      annotations: [{ page: 1, subtype: "Highlight", contents: `n${i}` }],
    });
    await new Promise((r) => setTimeout(r, 5));
  }
  const backups = await listBackups(root, pdfPath);
  assert.equal(backups.length, 3);
  assert.deepEqual(readdirSync(backups[0].dir).sort(), ["annotations.json", "paper.annotated.pdf", "paper.previous.pdf"]);
  const json = JSON.parse(readFileSync(path.join(backups[0].dir, "annotations.json"), "utf8"));
  assert.equal(json.annotations[0].contents, "n3"); // newest first
  assert.equal(json.source, pdfPath);
});

test("same-named PDFs in different folders get separate backup folders", () => {
  const a = backupDirFor("/r", "/one/paper.pdf");
  const b = backupDirFor("/r", "/two/paper.pdf");
  assert.notEqual(a, b);
  assert.match(path.basename(a), /^paper-[0-9a-f]{8}$/);
});
