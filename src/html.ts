/**
 * Turns PDF.js's stock viewer.html into a VS Code webview page: swaps in a
 * webview-compatible CSP, a <base> pointing at the viewer's folder, the bridge
 * script (which must run before viewer.mjs) and our stylesheet.
 */
export function buildViewerHtml(
  template: string,
  opts: { cspSource: string; mediaUrl: string; dark: boolean }
): string {
  const media = opts.mediaUrl.replace(/\/$/, "");
  const web = `${media}/pdfjs/web`;
  const cfg = {
    workerUrl: `${media}/pdfjs/build/pdf.worker.mjs`,
    cMapUrl: `${web}/cmaps/`,
    standardFontDataUrl: `${web}/standard_fonts/`,
    wasmUrl: `${web}/wasm/`,
    iccUrl: `${web}/iccs/`,
    dark: opts.dark,
  };

  const src = opts.cspSource;
  const csp = [
    "default-src 'none'",
    `script-src ${src} 'wasm-unsafe-eval'`,
    "worker-src blob:",
    `style-src ${src} 'unsafe-inline'`,
    `img-src ${src} blob: data:`,
    `font-src ${src} blob: data:`,
    `connect-src ${src} blob: data:`,
    "media-src blob:",
    `base-uri ${src}`,
    "form-action 'none'",
  ].join("; ");

  const head = [
    `<meta http-equiv="Content-Security-Policy" content="${csp}" />`,
    `<base href="${web}/" />`,
    `<script id="pdfa-config" type="application/json">${JSON.stringify(cfg).replace(/</g, "\\u003c")}</script>`,
    `<script src="${media}/bridge.mjs" type="module"></script>`,
    `<link rel="stylesheet" href="${media}/bridge.css" />`,
  ].join("\n");

  const out = template.replace(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/, head);
  if (out === template) throw new Error("Unexpected PDF.js viewer.html layout");
  return out;
}
