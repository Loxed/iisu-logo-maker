/// <reference lib="webworker" />
import { renderToRgba } from "./render";
import type { Params } from "./params";

type MaskMessage = { type: "mask"; key: string; data: ArrayBuffer; w: number; h: number };
type RenderMessage = { type: "render"; id: number; key: string; params: Params };
type Incoming = MaskMessage | RenderMessage;

const masks = new Map<string, { data: Uint8Array; w: number; h: number }>();
const MAX_MASKS = 4;

self.onmessage = (ev: MessageEvent<Incoming>) => {
  const msg = ev.data;
  if (msg.type === "mask") {
    masks.set(msg.key, { data: new Uint8Array(msg.data), w: msg.w, h: msg.h });
    while (masks.size > MAX_MASKS) masks.delete(masks.keys().next().value as string);
    return;
  }
  const started = performance.now();
  try {
    const mask = masks.get(msg.key);
    if (!mask) throw new Error("mask not loaded in the worker");
    const result = renderToRgba(mask.data, mask.w, mask.h, msg.params);
    const payload = {
      type: "result" as const,
      id: msg.id,
      ok: true as const,
      rgba: result.rgba,
      size: result.size,
      warnings: result.warnings,
      ms: Math.round(performance.now() - started),
    };
    (self as unknown as Worker).postMessage(payload, [result.rgba.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({
      type: "result" as const,
      id: msg.id,
      ok: false as const,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
