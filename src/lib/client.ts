/** Main thread side of the renderer: rasterize, keep the worker fed, render. */

import { loadLogoMask, probeInk } from "./raster";
import { computeLayout, scaleParams, type Params } from "./params";

export type RenderOutput = {
  rgba: Uint8ClampedArray<ArrayBuffer>;
  size: number;
  ms: number;
  warnings: string[];
};

type Pending = {
  resolve: (v: RenderOutput) => void;
  reject: (e: Error) => void;
};

export class Renderer {
  private worker: Worker;
  private pending = new Map<number, Pending>();
  private sentMasks = new Set<string>();
  private nextId = 1;

  constructor() {
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (ev: MessageEvent) => {
      const msg = ev.data;
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.ok) {
        entry.resolve({ rgba: msg.rgba, size: msg.size, ms: msg.ms, warnings: msg.warnings });
      } else {
        entry.reject(new Error(msg.error));
      }
    };
    this.worker.onerror = (ev) => {
      const err = new Error(ev.message || "render worker failed");
      this.pending.forEach((p) => p.reject(err));
      this.pending.clear();
    };
  }

  /** Rasterize at the resolution this parameter set needs, then render. */
  async render(svgText: string, params: Params): Promise<RenderOutput> {
    const scaled = scaleParams(params);
    const ink = await probeInk(svgText);
    const layout = computeLayout(ink.fracW, ink.fracH, scaled);
    const needed = Math.max(layout.logo.w, layout.logo.h) * scaled.supersample;
    const mask = await loadLogoMask(svgText, needed);

    if (!this.sentMasks.has(mask.key)) {
      const copy = mask.data.slice();
      this.worker.postMessage(
        { type: "mask", key: mask.key, data: copy.buffer, w: mask.w, h: mask.h },
        [copy.buffer]
      );
      this.sentMasks.add(mask.key);
      // the worker keeps the last few masks, so forget the oldest keys here too
      if (this.sentMasks.size > 4) {
        this.sentMasks.delete(this.sentMasks.values().next().value as string);
      }
    }

    const id = this.nextId++;
    return new Promise<RenderOutput>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ type: "render", id, key: mask.key, params });
    });
  }
}

export function toImageData(out: RenderOutput): ImageData {
  return new ImageData(out.rgba, out.size, out.size);
}

export async function toPngBlob(out: RenderOutput): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = out.size;
  canvas.height = out.size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("could not get a 2d context");
  ctx.putImageData(toImageData(out), 0, 0);
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
  canvas.width = canvas.height = 0;
  if (!blob) throw new Error("the browser could not encode the PNG");
  return blob;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
}
