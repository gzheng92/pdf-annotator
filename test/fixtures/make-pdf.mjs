import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { writeFileSync } from "fs";
export async function makePdf(version, pages = 3) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 1; p <= pages; p++) {
    const page = doc.addPage([612, 792]);
    page.drawText(`Draft ${version} - page ${p}`, { x: 72, y: 720, size: 24, font });
    for (let i = 0; i < 20; i++)
      page.drawText(`Line ${i + 1}: The quick brown fox jumps over the lazy dog (v${version}).`, { x: 72, y: 680 - i * 24, size: 12, font, color: rgb(0.1, 0.1, 0.1) });
  }
  return doc.save();
}
if (process.argv[2]) writeFileSync(process.argv[2], await makePdf(process.argv[3] || "1"));
