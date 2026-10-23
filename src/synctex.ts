import { promises as fs } from "fs";
import * as path from "path";
import { gunzipSync } from "zlib";

/**
 * Minimal SyncTeX reader for reverse search (PDF position -> source line).
 * Format reference: https://github.com/jlaurens/synctex (synctex_parser.c).
 */

interface Box {
  kind: "h" | "v";
  tag: number;
  line: number;
  // all in big points (1/72 in), measured from the page's top-left corner
  h: number;
  v: number;
  width: number;
  height: number;
  depth: number;
  leaves: Leaf[];
}

interface Leaf {
  tag: number;
  line: number;
  h: number;
  v: number;
}

export interface SyncTexData {
  inputs: Map<number, string>;
  pages: Map<number, Box[]>;
}

export interface SourceLocation {
  file: string;
  line: number; // 1-based
}

const RECORD = /^([[(hvxkg$])(\d+),(-?\d+):(-?\d+),(-?\d+)(?::(-?\d+)(?:,(-?\d+),(-?\d+))?)?/;

export function parseSyncTex(text: string, syncFile: string): SyncTexData {
  const baseDir = path.dirname(syncFile);
  const inputs = new Map<number, string>();
  const pages = new Map<number, Box[]>();
  let unit = 1;
  let mag = 1000;
  let xOffset = 0;
  let yOffset = 0;
  let toBp = 1 / 65781.76;

  let page = 0;
  let boxes: Box[] = [];
  const stack: Box[] = [];

  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line) continue;
    const c = line[0];

    if (line.startsWith("Input:")) {
      const m = /^Input:(\d+):(.*)$/.exec(line);
      if (m) inputs.set(Number(m[1]), path.normalize(path.resolve(baseDir, m[2])));
      continue;
    }
    if (page === 0) {
      if (line.startsWith("Unit:")) unit = Number(line.slice(5)) || 1;
      else if (line.startsWith("Magnification:")) mag = Number(line.slice(14)) || 1000;
      else if (line.startsWith("X Offset:")) xOffset = Number(line.slice(9)) || 0;
      else if (line.startsWith("Y Offset:")) yOffset = Number(line.slice(9)) || 0;
      toBp = (unit * mag) / 1000 / 65781.76;
    }
    if (c === "{") {
      page = Number(line.slice(1));
      boxes = [];
      stack.length = 0;
      continue;
    }
    if (c === "}") {
      if (page) pages.set(page, boxes);
      page = 0;
      continue;
    }
    if (!page) continue;
    if (c === ")" || c === "]") {
      stack.pop();
      continue;
    }

    const m = RECORD.exec(line);
    if (!m) continue;
    const [, type, tag, srcLine, h, v, w, ht, dp] = m;
    const parent = stack[stack.length - 1];
    const node = {
      tag: Number(tag),
      line: Number(srcLine),
      h: (Number(h) + xOffset) * toBp,
      v: (Number(v) + yOffset) * toBp,
    };
    if (type === "[" || type === "(" || ((type === "h" || type === "v") && w !== undefined)) {
      const box: Box = {
        kind: type === "[" || type === "v" ? "v" : "h",
        ...node,
        width: Number(w ?? 0) * toBp,
        height: Number(ht ?? 0) * toBp,
        depth: Number(dp ?? 0) * toBp,
        leaves: [],
      };
      if (type === "h" || type === "v") {
        // void box: a leaf of its parent, and a (childless) box of its own
        parent?.leaves.push(node);
      } else {
        stack.push(box);
      }
      boxes.push(box);
    } else {
      parent?.leaves.push(node);
    }
  }
  return { inputs, pages };
}

function contains(b: Box, x: number, y: number, slack = 0) {
  return (
    x >= b.h - slack &&
    x <= b.h + b.width + slack &&
    y >= b.v - b.height - slack &&
    y <= b.v + b.depth + slack
  );
}

function distance(b: Box, x: number, y: number) {
  const dx = x < b.h ? b.h - x : x > b.h + b.width ? x - b.h - b.width : 0;
  const top = b.v - b.height;
  const bottom = b.v + b.depth;
  const dy = y < top ? top - y : y > bottom ? y - bottom : 0;
  return Math.hypot(dx, dy * 2); // vertical distance matters more
}

/** Finds the source line for a point on `page` (1-based), given in bp from the page's top-left. */
export function reverseLookup(data: SyncTexData, page: number, x: number, y: number): SourceLocation | undefined {
  const boxes = data.pages.get(page);
  if (!boxes?.length) return undefined;

  // Prefer the innermost horizontal box (a typeset line) under the point.
  const hboxes = boxes.filter((b) => b.kind === "h" && b.width > 0 && b.height + b.depth > 0);
  let best: Box | undefined;
  for (const slack of [0, 2]) {
    for (const b of hboxes) {
      if (!contains(b, x, y, slack)) continue;
      if (!best || b.width * (b.height + b.depth) < best.width * (best.height + best.depth)) best = b;
    }
    if (best) break;
  }
  if (!best) {
    let bestDist = Infinity;
    for (const b of hboxes.length ? hboxes : boxes) {
      const d = distance(b, x, y);
      if (d < bestDist) {
        bestDist = d;
        best = b;
      }
    }
  }
  if (!best) return undefined;

  // Within that line, use the word/glue nearest to the left of the click.
  let leaves = best.leaves;
  // Paragraph lines often start with a node tagged with the paragraph's end line.
  if (leaves.some((l) => l.line !== best!.line)) leaves = leaves.filter((l) => l.line !== best!.line);
  let pick: Leaf | undefined;
  for (const l of leaves) {
    if (l.h <= x + 0.5 && (!pick || l.h >= pick.h)) pick = l;
  }
  pick ??= leaves.reduce<Leaf | undefined>((a, l) => (!a || l.h < a.h ? l : a), undefined);

  const tag = pick?.tag ?? best.tag;
  const line = pick?.line ?? best.line;
  const file = data.inputs.get(tag);
  if (!file || line <= 0) return undefined;
  return { file, line };
}

/** Locates the .synctex(.gz) file written next to `pdfPath`. */
export async function findSyncTexFile(pdfPath: string): Promise<string | undefined> {
  const stem = pdfPath.replace(/\.pdf$/i, "");
  for (const candidate of [`${stem}.synctex.gz`, `${stem}.synctex`, `${stem}.synctex(busy)`]) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // try next
    }
  }
  return undefined;
}

const cache = new Map<string, { mtimeMs: number; size: number; data: SyncTexData }>();

export async function loadSyncTex(file: string): Promise<SyncTexData> {
  const stat = await fs.stat(file);
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.data;
  const raw = await fs.readFile(file);
  const text = (file.endsWith(".gz") || (raw[0] === 0x1f && raw[1] === 0x8b) ? gunzipSync(raw) : raw).toString("utf8");
  const data = parseSyncTex(text, file);
  cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, data });
  return data;
}
