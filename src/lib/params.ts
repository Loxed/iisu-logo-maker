/**
 * Parameters and layout.
 *
 * Every length (strokeWidth, extrusionDepth, padding) is quoted at the
 * reference canvas size of 3000 px. scaleParams() multiplies them by
 * canvasSize / referenceSize, so a 640 px preview is an exact miniature of the
 * 3000 px export.
 */

/** `pos` places the stop along the linear ramp, `x` and `y` place it in the
 *  box for the point mode, both normalized 0 to 1. */
export type GradientStop = { pos: number; color: string; x?: number; y?: number };

export type Params = {
  canvasSize: number;
  referenceSize: number;
  scaleWithCanvas: boolean;
  padding: number;
  supersample: number;

  logoColor: string;
  logoEnabled: boolean;

  strokeWidth: number;
  /** close the pockets of the front face that the border cannot reach */
  fillHoles: boolean;
  gradientStops: GradientStop[];
  /** linear: one ramp along gradientAngle. points: every color sits at its own
   *  anchor in the box and the field between them is interpolated. */
  gradientMode: "linear" | "points";
  gradientAngle: number;
  /** point mode only: 1 blends broadly, 4 keeps each color close to its anchor */
  gradientSharpness: number;
  gradientSpace: "shape" | "canvas";

  extrusionEnabled: boolean;
  extrusionDepth: number;
  extrusionAngle: number;
  /** "auto" = last gradient stop, "gradient" = inherit the front face gradient, or a hex color */
  extrusionColor: string;

  shadingEnabled: boolean;
  extrusionDarken: number;
  shadingStrength: number;
  shadingSaturation: number;
  smoothness: number;
  highlightSize: number;
  highlightColor: string;
  highlightStrength: number;

  fitMode: "composite" | "front";
};

export const DEFAULTS: Params = {
  canvasSize: 3000,
  referenceSize: 3000,
  scaleWithCanvas: true,
  padding: 200,
  supersample: 2,

  logoColor: "#FFFFFF",
  logoEnabled: true,

  strokeWidth: 210,
  fillHoles: false,
  gradientStops: [
    { pos: 0, color: "#2FFF74" },
    { pos: 1, color: "#369052" },
  ],
  gradientMode: "linear",
  gradientAngle: 90,
  gradientSharpness: 1.6,
  gradientSpace: "shape",

  extrusionEnabled: true,
  extrusionDepth: 150,
  extrusionAngle: 90,
  extrusionColor: "auto",

  shadingEnabled: true,
  extrusionDarken: 0.15,
  shadingStrength: 0.2,
  shadingSaturation: 0.1,
  smoothness: 50,
  highlightSize: 0.1,
  highlightColor: "#FFFFFF",
  highlightStrength: 0,

  fitMode: "composite",
};

export type Preset = { name: string; params: Partial<Params> };

export const PRESETS: Preset[] = [
  { name: "Green Extruded", params: {} },
  { name: "Green Extruded (lit edge)", params: { highlightStrength: 0.15 } },
  {
    name: "Green Extruded (inherit gradient)",
    params: { extrusionColor: "gradient", extrusionDepth: 220, extrusionDarken: 0.18 },
  },
  {
    name: "Dark fold",
    params: { highlightColor: "#000000", highlightStrength: 0.22, highlightSize: 0.18 },
  },
  {
    name: "Sunset",
    params: {
      gradientStops: [
        { pos: 0, color: "#FFD166" },
        { pos: 1, color: "#D6455D" },
      ],
      extrusionDepth: 220,
      extrusionAngle: 115,
    },
  },
  {
    name: "Four corners",
    params: {
      gradientMode: "points",
      gradientStops: [
        { pos: 0, color: "#2AA84A", x: 0.5, y: 0.02 },
        { pos: 0.33, color: "#4285F4", x: 0.02, y: 0.5 },
        { pos: 0.66, color: "#FBBC04", x: 0.98, y: 0.5 },
        { pos: 1, color: "#EA4335", x: 0.5, y: 0.98 },
      ],
      extrusionColor: "gradient",
      extrusionDepth: 200,
    },
  },
  {
    name: "Blue Depth",
    params: {
      gradientStops: [
        { pos: 0, color: "#7CC7FF" },
        { pos: 1, color: "#1B6FB8" },
      ],
      extrusionColor: "gradient",
      extrusionDepth: 240,
      extrusionDarken: 0.2,
    },
  },
];

export function applyPreset(base: Params, preset: Preset): Params {
  return { ...base, ...preset.params };
}

export function scaleParams(p: Params): Params {
  if (!p.scaleWithCanvas || p.referenceSize <= 0) return p;
  const s = p.canvasSize / p.referenceSize;
  return {
    ...p,
    strokeWidth: p.strokeWidth * s,
    extrusionDepth: p.extrusionDepth * s,
    padding: p.padding * s,
    referenceSize: p.canvasSize,
    scaleWithCanvas: false,
  };
}

/** Anchor of a stop in the box, falling back to its position on the ramp. */
export function stopAnchor(s: GradientStop): [number, number] {
  return [s.x ?? 0.5, s.y ?? s.pos];
}

export function normalizedStops(p: Params): GradientStop[] {
  const stops: GradientStop[] = [...p.gradientStops]
    .map((s) => ({ pos: Number(s.pos), color: s.color, x: s.x, y: s.y }))
    .sort((a, b) => a.pos - b.pos);
  if (stops.length === 0) return [...DEFAULTS.gradientStops];
  if (stops[0].pos > 0) stops.unshift({ pos: 0, color: stops[0].color });
  const last = stops[stops.length - 1];
  if (last.pos < 1) stops.push({ pos: 1, color: last.color });
  return stops;
}

export function extrusionMode(p: Params): "flat" | "gradient" {
  return p.extrusionColor.trim().toLowerCase() === "gradient" ? "gradient" : "flat";
}

export function resolvedExtrusionColor(p: Params): string {
  const v = p.extrusionColor.trim().toLowerCase();
  if (v === "" || v === "auto" || v === "gradient") {
    const stops = normalizedStops(p);
    return stops[stops.length - 1].color;
  }
  return p.extrusionColor;
}

export type Layout = {
  logo: { x: number; y: number; w: number; h: number };
  front: { x: number; y: number; w: number; h: number };
  frontBox: [number, number, number, number];
  warnings: string[];
};

/** Place the artwork so border and extrusion always stay inside the canvas. */
export function computeLayout(maskW: number, maskH: number, p: Params): Layout {
  const size = p.canvasSize;
  const pad = p.padding;
  const stroke = Math.max(0, p.strokeWidth);
  const depth = p.extrusionEnabled ? Math.max(0, p.extrusionDepth) : 0;

  const a = (p.extrusionAngle * Math.PI) / 180;
  const ux = Math.cos(a);
  const uy = Math.sin(a);
  const extX = Math.abs(ux) * depth;
  const extY = Math.abs(uy) * depth;

  const avail = Math.max(16, size - 2 * pad);
  const longest = Math.max(maskW, maskH);
  const arW = maskW / longest;
  const arH = maskH / longest;

  const warnings: string[] = [];
  const limits =
    p.fitMode === "front"
      ? [
          (avail - 2 * stroke) / arW,
          (avail - 2 * stroke) / arH,
          (size - 2 * stroke - 2 * extX) / arW,
          (size - 2 * stroke - 2 * extY) / arH,
        ]
      : [(avail - 2 * stroke - extX) / arW, (avail - 2 * stroke - extY) / arH];

  let long = Math.min(...limits);
  if (long < avail * 0.04) {
    long = avail * 0.04;
    warnings.push(
      "stroke width and extrusion depth nearly fill the canvas, the artwork was clamped"
    );
  }

  const logoW = long * arW;
  const logoH = long * arH;
  const frontW = logoW + 2 * stroke;
  const frontH = logoH + 2 * stroke;

  let frontX: number;
  let frontY: number;
  if (p.fitMode === "front") {
    frontX = (size - frontW) / 2;
    frontY = (size - frontH) / 2;
  } else {
    frontX = (size - (frontW + extX)) / 2 + Math.max(0, -ux) * depth;
    frontY = (size - (frontH + extY)) / 2 + Math.max(0, -uy) * depth;
  }

  return {
    logo: { x: frontX + stroke, y: frontY + stroke, w: logoW, h: logoH },
    front: { x: frontX, y: frontY, w: frontW, h: frontH },
    frontBox: [frontX, frontY, frontX + frontW, frontY + frontH],
    warnings,
  };
}
