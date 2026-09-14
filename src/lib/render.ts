/**
 * The renderer. No DOM, no React: it takes an alpha mask plus parameters and
 * returns RGBA pixels, so it runs the same in a worker, in a batch loop or in
 * a test.
 *
 * Layers, bottom to top:
 *   1. extrusion, the front face swept over extrusionDepth at extrusionAngle
 *   2. front face, the silhouette expanded by strokeWidth, with the gradient
 *   3. logo, the original SVG silhouette in a flat color
 */

import {
  dilateRound,
  fillEnclosed,
  gradientLut,
  hexToRgb,
  resizeArea,
  shadingRamps,
  sweepMask,
  type Mask,
} from "./ops";
import {
  computeLayout,
  extrusionMode,
  normalizedStops,
  resolvedExtrusionColor,
  scaleParams,
  type Params,
} from "./params";

export type RenderResult = {
  rgba: Uint8ClampedArray<ArrayBuffer>;
  size: number;
  warnings: string[];
};

/** Flat extrusion color: one 256 entry ramp indexed by the sweep depth. */
function flatExtrusionLut(
  base: [number, number, number],
  ramps: ReturnType<typeof shadingRamps>,
  edgeColor: [number, number, number]
): Uint8Array {
  const lut = new Uint8Array(256 * 3);
  const mx = Math.max(base[0], base[1], base[2]);
  for (let i = 0; i < 256; i++) {
    const s = ramps.sat[i];
    const v = ramps.value[i];
    const e = ramps.edge[i];
    for (let c = 0; c < 3; c++) {
      let x = mx - (mx - base[c]) * s;
      x = Math.min(255, Math.max(0, x)) * v;
      x = x * (1 - e) + edgeColor[c] * e;
      lut[i * 3 + c] = Math.min(255, Math.max(0, x + 0.5)) | 0;
    }
  }
  return lut;
}

export function renderToRgba(
  mask: Uint8Array,
  logoMask: Uint8Array | null,
  maskW: number,
  maskH: number,
  rawParams: Params
): RenderResult {
  const p = scaleParams(rawParams);
  const size = Math.round(p.canvasSize);
  const ss = Math.max(1, Math.min(4, Math.round(p.supersample)));
  const work = size * ss;

  const layout = computeLayout(maskW, maskH, p);
  const warnings = [...layout.warnings];

  // --- place the logo on the supersampled canvas -------------------------
  const tw = Math.max(1, Math.round(layout.logo.w * ss));
  const th = Math.max(1, Math.round(layout.logo.h * ss));
  const ox = Math.max(0, Math.min(Math.round(layout.logo.x * ss), work - tw));
  const oy = Math.max(0, Math.min(Math.round(layout.logo.y * ss), work - th));
  const place = (src: Uint8Array): Mask => {
    const scaled = resizeArea(src, maskW, maskH, tw, th);
    const out: Mask = { data: new Uint8Array(work * work), w: work, h: work };
    for (let y = 0; y < th; y++) {
      out.data.set(scaled.subarray(y * tw, (y + 1) * tw), (oy + y) * work + ox);
    }
    return out;
  };
  // the silhouette drives outline and sweep; the artwork on top may come from
  // a different file, placed with the very same transform
  const shapeWork = place(mask);
  const logoWork = logoMask ? place(logoMask) : shapeWork;

  // --- front face and sweep ----------------------------------------------
  let outerWork = dilateRound(shapeWork, p.strokeWidth * ss);
  if (p.fillHoles) outerWork = fillEnclosed(outerWork);
  let extWork: Uint8Array | null = null;
  let depthWork: Uint8Array | null = null;
  if (p.extrusionEnabled && p.extrusionDepth >= 0.5) {
    const swept = sweepMask(outerWork, p.extrusionAngle, p.extrusionDepth * ss);
    extWork = swept.ext;
    depthWork = swept.depth;
  }

  // --- down to the canvas size -------------------------------------------
  const logoA = resizeArea(logoWork.data, work, work, size, size);
  const outerA = resizeArea(outerWork.data, work, work, size, size);
  logoWork.data = new Uint8Array(0);
  shapeWork.data = new Uint8Array(0);
  outerWork.data = new Uint8Array(0);

  let extA: Uint8Array | null = null;
  let depthA: Uint8Array | null = null;
  if (extWork && depthWork) {
    // alpha weighted average of the depth, so edge pixels of the extrusion
    // keep the right shade instead of picking up a fringe
    const weighted = new Uint8Array(extWork.length);
    for (let i = 0; i < weighted.length; i++) {
      weighted[i] = (depthWork[i] * extWork[i]) / 255;
    }
    extA = resizeArea(extWork, work, work, size, size);
    const num = resizeArea(weighted, work, work, size, size);
    depthA = new Uint8Array(size * size);
    for (let i = 0; i < depthA.length; i++) {
      const denom = extA[i];
      depthA[i] = denom < 1 ? 255 : Math.min(255, (num[i] * 255) / denom);
    }
    extWork = null;
    depthWork = null;
  }

  // --- colors -------------------------------------------------------------
  const stops = normalizedStops(p);
  const lut = gradientLut(stops);
  const lutN = lut.length / 3;
  const box =
    p.gradientSpace === "shape" ? layout.frontBox : ([0, 0, size, size] as const);
  const ga = (p.gradientAngle * Math.PI) / 180;
  const gx = Math.cos(ga);
  const gy = Math.sin(ga);
  const extent =
    Math.abs(gx) * Math.max(box[2] - box[0], 1e-6) +
    Math.abs(gy) * Math.max(box[3] - box[1], 1e-6);
  const cx = (box[0] + box[2]) / 2;
  const cy = (box[1] + box[3]) / 2;

  const ramps = shadingRamps({
    shadingEnabled: p.shadingEnabled,
    extrusionDarken: p.extrusionDarken,
    shadingStrength: p.shadingStrength,
    shadingSaturation: p.shadingSaturation,
    smoothness: p.smoothness,
    highlightSize: p.highlightSize,
    highlightStrength: p.highlightStrength,
  });
  const edgeRgb = hexToRgb(p.highlightColor);
  const inherit = extrusionMode(p) === "gradient";
  const flatLut = inherit
    ? null
    : flatExtrusionLut(hexToRgb(resolvedExtrusionColor(p)), ramps, edgeRgb);
  const logoRgb = hexToRgb(p.logoColor);
  const a = (p.extrusionAngle * Math.PI) / 180;
  const depthShift =
    (p.extrusionDepth * (Math.cos(a) * gx + Math.sin(a) * gy)) / extent;

  // --- composite ----------------------------------------------------------
  const out = new Uint8ClampedArray(size * size * 4);
  const dtg = gx / extent;
  for (let y = 0; y < size; y++) {
    let tg = 0.5 + (-cx * gx + (y - cy) * gy) / extent;
    const row = y * size;
    for (let x = 0; x < size; x++, tg += dtg) {
      const i = row + x;
      let pr = 0;
      let pg = 0;
      let pb = 0;
      let pa = 0;

      if (extA) {
        const ea = extA[i] / 255;
        if (ea > 0) {
          const d = depthA![i];
          let r: number;
          let g: number;
          let b: number;
          if (inherit) {
            const ts = tg - (d / 255) * depthShift;
            const gi =
              (Math.min(lutN - 1, Math.max(0, Math.round(ts * (lutN - 1)))) | 0) * 3;
            const s = ramps.sat[d];
            const v = ramps.value[d];
            const e = ramps.edge[d];
            const r0 = lut[gi];
            const g0 = lut[gi + 1];
            const b0 = lut[gi + 2];
            const mx = r0 > g0 ? (r0 > b0 ? r0 : b0) : g0 > b0 ? g0 : b0;
            r = (mx - (mx - r0) * s) * v;
            g = (mx - (mx - g0) * s) * v;
            b = (mx - (mx - b0) * s) * v;
            if (e > 0) {
              r = r * (1 - e) + edgeRgb[0] * e;
              g = g * (1 - e) + edgeRgb[1] * e;
              b = b * (1 - e) + edgeRgb[2] * e;
            }
          } else {
            const li = d * 3;
            r = flatLut![li];
            g = flatLut![li + 1];
            b = flatLut![li + 2];
          }
          pr = r * ea;
          pg = g * ea;
          pb = b * ea;
          pa = ea;
        }
      }

      const fa = outerA[i] / 255;
      if (fa > 0) {
        const gi = (Math.min(lutN - 1, Math.max(0, Math.round(tg * (lutN - 1)))) | 0) * 3;
        const inv = 1 - fa;
        pr = pr * inv + lut[gi] * fa;
        pg = pg * inv + lut[gi + 1] * fa;
        pb = pb * inv + lut[gi + 2] * fa;
        pa = pa * inv + fa;
      }

      if (p.logoEnabled) {
        const la = logoA[i] / 255;
        if (la > 0) {
          const inv = 1 - la;
          pr = pr * inv + logoRgb[0] * la;
          pg = pg * inv + logoRgb[1] * la;
          pb = pb * inv + logoRgb[2] * la;
          pa = pa * inv + la;
        }
      }

      const o = i * 4;
      if (pa > 0) {
        out[o] = pr / pa + 0.5;
        out[o + 1] = pg / pa + 0.5;
        out[o + 2] = pb / pa + 0.5;
        out[o + 3] = pa * 255 + 0.5;
      }
    }
  }

  return { rgba: out, size, warnings };
}
