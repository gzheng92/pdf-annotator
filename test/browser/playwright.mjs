// Uses the project's playwright package, or one given by PLAYWRIGHT_MODULE (a node_modules
// path). Set PW_CHANNEL=chrome to drive an installed Google Chrome instead of downloading
// Playwright's own Chromium (used in CI).
import { createRequire } from "module";
const req = createRequire(process.env.PLAYWRIGHT_MODULE ? process.env.PLAYWRIGHT_MODULE + "/" : import.meta.url);
const pw = req("playwright");
const channel = process.env.PW_CHANNEL;
export const chromium = {
  launch: (opts = {}) => pw.chromium.launch(channel ? { channel, ...opts } : opts),
};
