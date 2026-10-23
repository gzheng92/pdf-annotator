import { chromium } from "./playwright.mjs";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "fs";
import { start } from "./harness.mjs";
import { mkdirSync } from "fs";
mkdirSync("test/.out", { recursive: true });
import { listAnnotations } from "../.lib/annotations.mjs";

const server = start();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") errors.push(`${m.type()}: ${m.text()}`); });
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

const waitHost = (type, n = 1) =>
  page.waitForFunction(([t, n]) => window.__toHost.filter((m) => m.type === t).length >= n, [type, n], { timeout: 20000 });
const sendLoad = (bytes, extra = {}) =>
  page.evaluate(([arr, extra]) => window.postMessage({ type: "load", data: new Uint8Array(arr), filename: "sample.pdf", ...extra }, "*"), [Array.from(bytes), extra]);
const getData = async (id) => {
  await page.evaluate((id) => window.postMessage({ type: "getData", requestId: id }, "*"), id);
  await page.waitForFunction((id) => window.__toHost.some((m) => m.type === "data" && m.requestId === id), id, { timeout: 20000 });
  const r = await page.evaluate((id) => { const m = window.__toHost.find((m) => m.type === "data" && m.requestId === id); return m.error ? { error: m.error } : { data: Array.from(m.data) }; }, id);
  if (r.error) throw new Error(r.error);
  return new Uint8Array(r.data);
};
const dirtyCount = () => page.evaluate(() => window.__toHost.filter((m) => m.type === "dirty").length);

try {
  await page.goto(server.url);
  await waitHost("ready");
  console.log("✓ viewer initialized");

  await sendLoad(readFileSync("test/fixtures/sample.pdf"));
  await waitHost("loaded");
  await page.waitForSelector(".page[data-page-number='1'] .textLayer span", { timeout: 20000 });
  console.log("✓ PDF rendered:", await page.evaluate(() => PDFViewerApplication.pagesCount), "pages; dirty msgs:", await dirtyCount());

  // Unannotated -> getData returns the original bytes.
  const plain = await getData(1);
  console.log("✓ getData (no edits):", plain.length, "bytes,", (await listAnnotations(plain)).length, "annotations");

  // Free text annotation
  await page.click("#editorFreeTextButton");
  const box = await page.locator(".page[data-page-number='1'] .canvasWrapper").boundingBox();
  await page.mouse.click(box.x + 300, box.y + 120);
  await page.keyboard.type("Reviewer note: check this");
  await page.mouse.click(box.x + 50, box.y + 500); // commit
  // Ink drawing
  await page.click("#editorInkButton");
  await page.mouse.move(box.x + 100, box.y + 300);
  await page.mouse.down();
  for (let i = 0; i < 20; i++) await page.mouse.move(box.x + 100 + i * 10, box.y + 300 + (i % 2) * 15);
  await page.mouse.up();
  await page.keyboard.press("Escape");
  // Highlight: select text then use highlight tool
  await page.click("#editorHighlightButton");
  const span = page.locator(".page[data-page-number='1'] .textLayer span", { hasText: "Line 3" }).first();
  const sb = await span.boundingBox();
  await page.mouse.move(sb.x + 2, sb.y + sb.height / 2);
  await page.mouse.down();
  await page.mouse.move(sb.x + sb.width - 2, sb.y + sb.height / 2, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  await page.keyboard.press("Escape");

  console.log("✓ dirty messages after editing:", await dirtyCount());
  const annotated = await getData(2);
  const list = await listAnnotations(annotated);
  console.log("✓ annotated PDF:", annotated.length, "bytes; annotations:", list.map((a) => a.subtype + (a.contents ? `("${a.contents}")` : "")).join(", "));
  assert.deepEqual(list.map((a) => a.subtype).sort(), ["FreeText", "Highlight", "Ink"]);
  writeFileSync("test/.out/out-annotated.pdf", annotated);
  await page.screenshot({ path: "test/.out/shot-annotated.png" });

  // Simulate save -> markSaved; then another edit should re-fire dirty
  await page.evaluate(() => window.postMessage({ type: "markSaved" }, "*"));
  const before = await dirtyCount();
  await page.click("#editorFreeTextButton");
  await page.mouse.click(box.x + 300, box.y + 600);
  await page.keyboard.type("Second note");
  await page.mouse.click(box.x + 50, box.y + 700);
  await page.waitForTimeout(300);
  console.log("✓ dirty re-fired after save:", (await dirtyCount()) > before);
  const after = await listAnnotations(await getData(3));
  console.log("✓ after markSaved, saving still has all annotations:", after.length);

  // Reload with a new version, preserving view (overwrite case)
  await page.evaluate(() => { PDFViewerApplication.pdfViewer.currentScaleValue = "1.5"; PDFViewerApplication.pdfViewer.container.scrollTop = 900; });
  await page.waitForTimeout(300);
  const posBefore = await page.evaluate(() => [PDFViewerApplication.pdfViewer.currentScale, PDFViewerApplication.pdfViewer.container.scrollTop]);
  const { makePdf } = await import("../fixtures/make-pdf.mjs");
  const loadedBefore = await page.evaluate(() => window.__toHost.filter((m) => m.type === "loaded").length);
  await sendLoad(await makePdf("2"), { preserveView: true });
  await waitHost("loaded", loadedBefore + 1);
  await page.waitForTimeout(800);
  const posAfter = await page.evaluate(() => [PDFViewerApplication.pdfViewer.currentScale, PDFViewerApplication.pdfViewer.container.scrollTop]);
  const txt = await page.locator(".page[data-page-number='1'] .textLayer").first().innerText().catch(() => "");
  console.log("✓ reloaded v2:", txt.includes("Draft 2"), "view before", posBefore, "after", posAfter);
  const v2 = await listAnnotations(await getData(4));
  console.log("✓ v2 annotations (should be 0):", v2.length);
  assert.equal(v2.length, 0);
  assert.ok(txt.includes("Draft 2"));
  assert.deepEqual(posAfter, posBefore);
  await page.screenshot({ path: "test/.out/shot-reloaded.png" });

  // Dark theme renders
  const p2 = await browser.newPage();
  await p2.goto(server.url + "?dark");
  await p2.waitForFunction(() => window.__toHost?.some((m) => m.type === "ready"));
  console.log("✓ dark page ready");
} catch (e) {
  console.error("✗ FAILED:", e.message);
  await page.screenshot({ path: "test/.out/shot-fail.png" }).catch(() => {});
  process.exitCode = 1;
} finally {
  console.log("console errors/warnings:\n " + errors.filter((e) => !e.includes("favicon")).slice(0, 15).join("\n "));
  await browser.close();
  server.close();
}
