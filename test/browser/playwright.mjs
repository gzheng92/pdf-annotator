// Uses the project's playwright devDependency, or a globally provided one
// (set PLAYWRIGHT_MODULE to its path, e.g. in containers with a preinstalled browser).
import { createRequire } from "module";
const req = createRequire(process.env.PLAYWRIGHT_MODULE ? process.env.PLAYWRIGHT_MODULE + "/" : import.meta.url);
export const { chromium } = req("playwright");
