import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { findSyncTexFile, loadSyncTex, reverseLookup } from "../.lib/synctex.mjs";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/latex");
const expected = JSON.parse(readFileSync(path.join(dir, "expected-synctex.json"), "utf8")).points;

test("finds the .synctex.gz next to the PDF", async () => {
  assert.equal(await findSyncTexFile(path.join(dir, "main.pdf")), path.join(dir, "main.synctex.gz"));
  assert.equal(await findSyncTexFile(path.join(dir, "missing.pdf")), undefined);
});

test("agrees with the official synctex tool on clicks over text", async () => {
  const data = await loadSyncTex(path.join(dir, "main.synctex.gz"));
  let exact = 0;
  const misses = [];
  for (const p of expected) {
    const r = reverseLookup(data, p.page, p.x, p.y);
    if (r && path.basename(r.file) === p.file && r.line === p.line) exact++;
    else if (!r || path.basename(r.file) !== p.file || Math.abs(r.line - p.line) > 1) misses.push({ ...p, got: r && `${path.basename(r.file)}:${r.line}` });
  }
  assert.deepEqual(misses, [], "no click should land more than a line away");
  assert.ok(exact / expected.length >= 0.9, `exact matches: ${exact}/${expected.length}`);
});

test("resolves \\input files and specific lines", async () => {
  const data = await loadSyncTex(path.join(dir, "main.synctex.gz"));
  const inChapter = expected.find((p) => p.file === "two.tex" && p.line === 2);
  const r = reverseLookup(data, inChapter.page, inChapter.x, inChapter.y);
  assert.equal(path.basename(r.file), "two.tex");
  assert.equal(r.line, 2);
});
