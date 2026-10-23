// Serves the webview page from one origin and the extension's media from another,
// mimicking VS Code's webview setup, with a stand-in for acquireVsCodeApi().
import http from "http";
import { readFileSync, existsSync, statSync } from "fs";
import path from "path";
import { buildViewerHtml } from "../.lib/html.mjs";

const root = path.resolve(new URL("../..", import.meta.url).pathname);
const media = path.join(root, "media");
const types = { ".mjs": "text/javascript", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".wasm": "application/wasm", ".ftl": "text/plain", ".bcmap": "application/octet-stream" };

export function start(pagePort = 8801, resPort = 8802) {
  const resOrigin = `http://127.0.0.1:${resPort}`;
  const pageOrigin = `http://localhost:${pagePort}`;
  const res = http.createServer((req, rsp) => {
    const p = path.join(media, decodeURIComponent(new URL(req.url, resOrigin).pathname));
    if (!p.startsWith(media) || !existsSync(p) || statSync(p).isDirectory()) { rsp.writeHead(404); return rsp.end(); }
    rsp.writeHead(200, { "Content-Type": types[path.extname(p)] || "application/octet-stream", "Access-Control-Allow-Origin": "*" });
    rsp.end(readFileSync(p));
  }).listen(resPort);
  const page = http.createServer((req, rsp) => {
    if (req.url.startsWith("/shim.js")) {
      rsp.writeHead(200, { "Content-Type": "text/javascript" });
      return rsp.end(`window.__toHost=[];window.acquireVsCodeApi=()=>({postMessage:(m)=>{window.__toHost.push(m)},getState(){},setState(){}});`);
    }
    const template = readFileSync(path.join(media, "pdfjs/web/viewer.html"), "utf8");
    let html = buildViewerHtml(template, { cspSource: `${resOrigin} ${pageOrigin}`, mediaUrl: resOrigin, dark: req.url.includes("dark") });
    html = html.replace("<head>", `<head><script src="${pageOrigin}/shim.js"></script>`);
    rsp.writeHead(200, { "Content-Type": "text/html" });
    rsp.end(html);
  }).listen(pagePort);
  return { url: `${pageOrigin}/`, close: () => { res.close(); page.close(); } };
}
