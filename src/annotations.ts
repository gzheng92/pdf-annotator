import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFObjectCopier,
  PDFPage,
  PDFRef,
  PDFString,
} from "pdf-lib";

/** Annotation types people create while reviewing (excludes links, form widgets, etc.). */
export const MARKUP_SUBTYPES = new Set([
  "Text",
  "FreeText",
  "Line",
  "Square",
  "Circle",
  "Polygon",
  "PolyLine",
  "Highlight",
  "Underline",
  "Squiggly",
  "StrikeOut",
  "Stamp",
  "Caret",
  "Ink",
  "FileAttachment",
]);

/** Keys that point back into the source document's structure and must not be copied. */
const NON_PORTABLE_KEYS = new Set(["P", "Parent", "Popup", "IRT", "StructParent", "OC"]);

export interface AnnotationInfo {
  page: number; // 1-based
  subtype: string;
  rect?: number[];
  contents?: string;
  author?: string;
  subject?: string;
  color?: number[];
  modified?: string;
  quadPoints?: number[];
}

async function loadPdf(bytes: Uint8Array): Promise<PDFDocument> {
  return PDFDocument.load(bytes, {
    ignoreEncryption: true,
    updateMetadata: false,
    throwOnInvalidObject: false,
  });
}

function nameOf(obj: PDFObject | undefined): string | undefined {
  return obj instanceof PDFName ? obj.decodeText() : undefined;
}

function textOf(obj: PDFObject | undefined): string | undefined {
  if (obj instanceof PDFString || obj instanceof PDFHexString) {
    try {
      return obj.decodeText();
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function numbersOf(doc: PDFDocument, obj: PDFObject | undefined): number[] | undefined {
  const arr = obj instanceof PDFRef ? doc.context.lookup(obj) : obj;
  if (!(arr instanceof PDFArray)) return undefined;
  const out: number[] = [];
  for (let i = 0; i < arr.size(); i++) {
    const n = doc.context.lookup(arr.get(i));
    if (n instanceof PDFNumber) out.push(Math.round(n.asNumber() * 100) / 100);
  }
  return out;
}

function markupAnnots(doc: PDFDocument, page: PDFPage): PDFDict[] {
  const annots = page.node.lookup(PDFName.of("Annots"));
  if (!(annots instanceof PDFArray)) return [];
  const out: PDFDict[] = [];
  for (let i = 0; i < annots.size(); i++) {
    const dict = doc.context.lookup(annots.get(i));
    if (dict instanceof PDFDict && MARKUP_SUBTYPES.has(nameOf(dict.get(PDFName.of("Subtype"))) ?? "")) {
      out.push(dict);
    }
  }
  return out;
}

function describe(doc: PDFDocument, dict: PDFDict, page: number): AnnotationInfo {
  const info: AnnotationInfo = {
    page,
    subtype: nameOf(dict.get(PDFName.of("Subtype"))) ?? "Unknown",
  };
  const rect = numbersOf(doc, dict.get(PDFName.of("Rect")));
  if (rect) info.rect = rect;
  const contents = textOf(dict.lookup(PDFName.of("Contents")));
  if (contents) info.contents = contents;
  const author = textOf(dict.lookup(PDFName.of("T")));
  if (author) info.author = author;
  const subject = textOf(dict.lookup(PDFName.of("Subj")));
  if (subject) info.subject = subject;
  const color = numbersOf(doc, dict.get(PDFName.of("C")));
  if (color?.length) info.color = color;
  const modified = textOf(dict.lookup(PDFName.of("M")));
  if (modified) info.modified = modified;
  const quad = numbersOf(doc, dict.get(PDFName.of("QuadPoints")));
  if (quad?.length) info.quadPoints = quad;
  return info;
}

/** Lists the reviewer annotations (highlights, notes, ink, …) in a PDF. */
export async function listAnnotations(bytes: Uint8Array): Promise<AnnotationInfo[]> {
  const doc = await loadPdf(bytes);
  const out: AnnotationInfo[] = [];
  doc.getPages().forEach((page, i) => {
    for (const dict of markupAnnots(doc, page)) out.push(describe(doc, dict, i + 1));
  });
  return out;
}

function signature(a: AnnotationInfo): string {
  return JSON.stringify([a.page, a.subtype, a.rect, a.contents ?? "", a.quadPoints ?? []]);
}

export interface CopyResult {
  bytes: Uint8Array;
  copied: number;
  alreadyPresent: number;
  droppedPages: number; // annotations on pages the new PDF no longer has
}

/**
 * Copies the reviewer annotations of `fromBytes` onto the same page numbers of
 * `toBytes`. Annotations already present in the target (same type, place and
 * text) are not duplicated.
 */
export async function copyAnnotations(fromBytes: Uint8Array, toBytes: Uint8Array): Promise<CopyResult> {
  const src = await loadPdf(fromBytes);
  const dst = await loadPdf(toBytes);
  const copier = PDFObjectCopier.for(src.context, dst.context);
  const srcPages = src.getPages();
  const dstPages = dst.getPages();

  const existing = new Set<string>();
  dstPages.forEach((page, i) => {
    for (const dict of markupAnnots(dst, page)) existing.add(signature(describe(dst, dict, i + 1)));
  });

  let copied = 0;
  let alreadyPresent = 0;
  let droppedPages = 0;
  srcPages.forEach((srcPage, i) => {
    const annots = markupAnnots(src, srcPage);
    if (!annots.length) return;
    const dstPage = dstPages[i];
    if (!dstPage) {
      droppedPages += annots.length;
      return;
    }
    for (const dict of annots) {
      const sig = signature(describe(src, dict, i + 1));
      if (existing.has(sig)) {
        alreadyPresent++;
        continue;
      }
      const portable = PDFDict.withContext(src.context);
      for (const [key, value] of dict.entries()) {
        if (!NON_PORTABLE_KEYS.has(key.decodeText())) portable.set(key, value);
      }
      const clone = copier.copy(portable);
      clone.set(PDFName.of("P"), dstPage.ref);
      dstPage.node.addAnnot(dst.context.register(clone));
      existing.add(sig);
      copied++;
    }
  });

  const bytes = copied > 0 ? await dst.save({ useObjectStreams: false }) : toBytes;
  return { bytes, copied, alreadyPresent, droppedPages };
}
