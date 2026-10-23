// Downloads Mozilla's prebuilt PDF.js viewer (legacy build, for Electron/older Chromium
// compatibility) into media/pdfjs. Run automatically by `npm install` / `npm run build`.
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import AdmZip from "adm-zip";

const VERSION = "6.4.299";
const SHA256 = process.env.PDFJS_SHA256 || "c894bce53b2f4c3e13141e088c89cc051a1f7118ba4a2c02ec058798ae1303d1";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dest = path.join(root, "media", "pdfjs");
const stamp = path.join(dest, ".version");

if (existsSync(stamp) && readFileSync(stamp, "utf8").trim() === VERSION && !process.argv.includes("--force")) {
  process.exit(0);
}

const url = `https://github.com/mozilla/pdf.js/releases/download/v${VERSION}/pdfjs-${VERSION}-legacy-dist.zip`;
console.log(`Downloading PDF.js ${VERSION} viewer…`);
const res = await fetch(url);
if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
const zip = Buffer.from(await res.arrayBuffer());
const hash = createHash("sha256").update(zip).digest("hex");
if (hash !== SHA256) throw new Error(`PDF.js archive checksum mismatch: got ${hash}`);

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
new AdmZip(zip).extractAllTo(dest, true);

// Drop what the extension doesn't ship: source maps, the debugger and the demo PDF.
for (const f of [
  "web/compressed.tracemonkey-pldi-09.pdf", "web/debugger.mjs", "web/debugger.css",
  "web/viewer.mjs.map", "build/pdf.mjs.map", "build/pdf.worker.mjs.map", "build/pdf.sandbox.mjs.map",
]) rmSync(path.join(dest, f), { force: true });

writeFileSync(stamp, VERSION + "\n");
console.log(`PDF.js ${VERSION} ready in media/pdfjs`);
