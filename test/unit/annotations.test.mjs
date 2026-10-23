import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, PDFName, PDFString, PDFArray } from "pdf-lib";
import { copyAnnotations, listAnnotations } from "../.lib/annotations.mjs";
import { makePdf } from "../fixtures/make-pdf.mjs";

/** A PDF with a highlight and a sticky note on page 1 and a free-text box on page 3. */
async function annotated() {
  const doc = await PDFDocument.load(await makePdf("1"));
  const add = (pageIndex, dict) => {
    const page = doc.getPage(pageIndex);
    const ref = doc.context.register(doc.context.obj({ Type: "Annot", P: page.ref, ...dict }));
    page.node.addAnnot(ref);
  };
  add(0, { Subtype: "Highlight", Rect: [72, 650, 300, 666], QuadPoints: [72, 666, 300, 666, 72, 650, 300, 650], C: [1, 1, 0], Contents: PDFString.of("check this") });
  add(0, { Subtype: "Text", Rect: [400, 700, 420, 720], Contents: PDFString.of("a note"), T: PDFString.of("Me") });
  add(2, { Subtype: "FreeText", Rect: [100, 100, 250, 130], Contents: PDFString.of("page three box") });
  // A link annotation: not a reviewer annotation, must be ignored.
  add(0, { Subtype: "Link", Rect: [0, 0, 10, 10] });
  return doc.save();
}

test("lists reviewer annotations only", async () => {
  const list = await listAnnotations(await annotated());
  assert.deepEqual(list.map((a) => `${a.subtype}@${a.page}`), ["Highlight@1", "Text@1", "FreeText@3"]);
  assert.equal(list[0].contents, "check this");
  assert.equal(list[1].author, "Me");
  assert.deepEqual(list[0].color, [1, 1, 0]);
});

test("copies annotations onto a rebuilt PDF, on the same pages", async () => {
  const r = await copyAnnotations(await annotated(), await makePdf("2"));
  assert.equal(r.copied, 3);
  assert.equal(r.droppedPages, 0);
  const list = await listAnnotations(r.bytes);
  assert.deepEqual(list.map((a) => `${a.subtype}@${a.page}`), ["Highlight@1", "Text@1", "FreeText@3"]);
  // The copy must point at its new page, not the old document's.
  const doc = await PDFDocument.load(r.bytes);
  const annots = doc.getPage(0).node.lookup(PDFName.of("Annots"), PDFArray);
  const first = doc.context.lookup(annots.get(0));
  assert.equal(first.get(PDFName.of("P")).toString(), doc.getPage(0).ref.toString());
});

test("does not duplicate annotations that are already there", async () => {
  const once = await copyAnnotations(await annotated(), await makePdf("2"));
  const twice = await copyAnnotations(await annotated(), once.bytes);
  assert.equal(twice.copied, 0);
  assert.equal(twice.alreadyPresent, 3);
});

test("reports annotations on pages the new version no longer has", async () => {
  const r = await copyAnnotations(await annotated(), await makePdf("2", 1));
  assert.equal(r.copied, 2);
  assert.equal(r.droppedPages, 1);
});
