/**
 * SVG to a tight anti aliased alpha mask, using the browser's own SVG
 * rasterizer.
 *
 * The viewBox is not trusted for framing, since icon files often carry empty
 * margins. The file is rasterized once small to measure the real ink box, then
 * again at the resolution that makes that box the requested size, then cropped
 * to it.
 */

export type MaskData = { data: Uint8Array; w: number; h: number; key: string };

const PROBE_WIDTH = 512;
const MAX_RASTER = 8192;
const ALPHA_EPS = 2;

type Ink = { fracW: number; fracH: number };

const probeCache = new Map<string, Ink>();
const maskCache = new Map<string, MaskData>();
const MASK_CACHE_MAX = 4;

export function hashSvg(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 + c, 2246822519) >>> 0;
  }
  return h1.toString(36) + h2.toString(36) + text.length.toString(36);
}

/** Give the root svg an explicit pixel size so the browser rasterizes it there. */
function sizedSvg(text: string, width: number): { markup: string; height: number } {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const svg = doc.documentElement;
  if (!svg || svg.nodeName.toLowerCase() !== "svg") {
    throw new Error("this file does not contain an <svg> root element");
  }
  let aspect = 1;
  const viewBox = svg.getAttribute("viewBox");
  const attrW = parseFloat(svg.getAttribute("width") || "");
  const attrH = parseFloat(svg.getAttribute("height") || "");
  if (viewBox) {
    const v = viewBox.split(/[\s,]+/).map(Number);
    if (v.length === 4 && v[2] > 0 && v[3] > 0) aspect = v[3] / v[2];
  } else if (attrW > 0 && attrH > 0) {
    aspect = attrH / attrW;
    svg.setAttribute("viewBox", `0 0 ${attrW} ${attrH}`);
  }
  const height = Math.max(1, Math.round(width * aspect));
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  return { markup: new XMLSerializer().serializeToString(svg), height };
}

async function alphaPlane(text: string, width: number): Promise<MaskData> {
  const { markup, height } = sizedSvg(text, width);
  const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(markup);
  const img = new Image();
  img.decoding = "sync";
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("the browser could not rasterize this SVG"));
    img.src = url;
  });

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("could not get a 2d context");
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);

  // read in strips so a large icon never needs one huge ImageData
  const out = new Uint8Array(width * height);
  const strip = Math.max(1, Math.min(height, Math.floor(8_000_000 / width)));
  for (let y0 = 0; y0 < height; y0 += strip) {
    const rows = Math.min(strip, height - y0);
    const px = ctx.getImageData(0, y0, width, rows).data;
    const base = y0 * width;
    for (let i = 0, n = rows * width; i < n; i++) out[base + i] = px[i * 4 + 3];
  }
  canvas.width = canvas.height = 0;
  return { data: out, w: width, h: height, key: "" };
}

function inkBox(m: MaskData): [number, number, number, number] | null {
  let x0 = m.w;
  let y0 = m.h;
  let x1 = 0;
  let y1 = 0;
  for (let y = 0; y < m.h; y++) {
    const row = y * m.w;
    for (let x = 0; x < m.w; x++) {
      if (m.data[row + x] > ALPHA_EPS) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < x0 || y1 < y0 ? null : [x0, y0, x1 + 1, y1 + 1];
}

/** Ink box of the SVG relative to the render width, measured once and cached. */
export async function probeInk(text: string): Promise<Ink> {
  const key = hashSvg(text);
  const hit = probeCache.get(key);
  if (hit) return hit;
  const small = await alphaPlane(text, PROBE_WIDTH);
  const box = inkBox(small);
  if (!box) throw new Error("this SVG rasterizes to an empty image");
  const ink: Ink = {
    fracW: (box[2] - box[0]) / small.w,
    fracH: (box[3] - box[1]) / small.w,
  };
  probeCache.set(key, ink);
  return ink;
}

/** Rasterize so the ink box is about contentPx on its longest side, cropped. */
export async function loadLogoMask(text: string, contentPx: number): Promise<MaskData> {
  const bucket = Math.ceil(Math.max(64, contentPx) / 256) * 256;
  const key = hashSvg(text) + ":" + bucket;
  const hit = maskCache.get(key);
  if (hit) return hit;

  const ink = await probeInk(text);
  const longest = Math.max(ink.fracW, ink.fracH, 1e-6);
  const width = Math.max(PROBE_WIDTH, Math.min(Math.round(bucket / longest), MAX_RASTER));

  const full = await alphaPlane(text, width);
  const box = inkBox(full);
  if (!box) throw new Error("this SVG rasterizes to an empty image");
  const [x0, y0, x1, y1] = box;
  const w = x1 - x0;
  const h = y1 - y0;
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    data.set(full.data.subarray((y0 + y) * full.w + x0, (y0 + y) * full.w + x1), y * w);
  }
  const mask: MaskData = { data, w, h, key };
  maskCache.set(key, mask);
  while (maskCache.size > MASK_CACHE_MAX) {
    maskCache.delete(maskCache.keys().next().value as string);
  }
  return mask;
}
