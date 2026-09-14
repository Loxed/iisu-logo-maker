/**
 * Mask, sweep, gradient and shading primitives.
 *
 * Masks are Uint8Array alpha planes, row major, w * h. Everything here is
 * deterministic: no blur, no random jitter, no drop shadow.
 */

export type Mask = { data: Uint8Array; w: number; h: number };

export const newMask = (w: number, h: number): Mask => ({
  data: new Uint8Array(w * h),
  w,
  h,
});

// --------------------------------------------------------------------------
// colors
// --------------------------------------------------------------------------
export function hexToRgb(value: string): [number, number, number] {
  let s = value.trim().replace(/^#/, "");
  if (s.length === 3) s = s.split("").map((c) => c + c).join("");
  if (s.length === 8) s = s.slice(0, 6);
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return [255, 255, 255];
  return [
    parseInt(s.slice(0, 2), 16),
    parseInt(s.slice(2, 4), 16),
    parseInt(s.slice(4, 6), 16),
  ];
}

export function rgbToHex(rgb: [number, number, number]): string {
  return (
    "#" +
    rgb
      .map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase()
  );
}

// --------------------------------------------------------------------------
// easing
// --------------------------------------------------------------------------
const smootherstep = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

export function ease(t: number, smoothness: number): number {
  const s = Math.min(1, Math.max(0, smoothness / 100));
  const x = Math.min(1, Math.max(0, t));
  return s <= 0 ? x : (1 - s) * x + s * smootherstep(x);
}

// --------------------------------------------------------------------------
// exact euclidean distance transform (Felzenszwalb and Huttenlocher)
// --------------------------------------------------------------------------
const INF = 1e20;

function edt1d(
  f: Float64Array,
  d: Float64Array,
  v: Int32Array,
  z: Float64Array,
  n: number
): void {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dx = q - v[k];
    d[q] = dx * dx + f[v[k]];
  }
}

/** Squared distance to the nearest pixel whose alpha is at least 128. */
export function squaredDistanceToShape(mask: Mask): Float32Array {
  const { data, w, h } = mask;
  // the grid holds squared distances in float32 to halve the peak memory at
  // 6000 x 6000, while the per line solver below stays in float64
  const grid = new Float32Array(w * h);
  for (let i = 0; i < grid.length; i++) grid[i] = data[i] >= 128 ? 0 : INF;

  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);

  for (let y = 0; y < h; y++) {
    const base = y * w;
    for (let x = 0; x < w; x++) f[x] = grid[base + x];
    edt1d(f, d, v, z, w);
    for (let x = 0; x < w; x++) grid[base + x] = d[x];
  }
  // the column pass runs on strips of 32 columns at a time: one strip stays in
  // cache for the whole pass, where column by column access would miss on
  // every row of a 6000 pixel image
  const STRIP = 32;
  const strip = new Float32Array(h * STRIP);
  for (let x0 = 0; x0 < w; x0 += STRIP) {
    const cols = Math.min(STRIP, w - x0);
    for (let y = 0; y < h; y++) {
      const src = y * w + x0;
      const dst = y * cols;
      for (let c = 0; c < cols; c++) strip[dst + c] = grid[src + c];
    }
    for (let c = 0; c < cols; c++) {
      for (let y = 0; y < h; y++) f[y] = strip[y * cols + c];
      edt1d(f, d, v, z, h);
      for (let y = 0; y < h; y++) strip[y * cols + c] = d[y];
    }
    for (let y = 0; y < h; y++) {
      const dst = y * w + x0;
      const src = y * cols;
      for (let c = 0; c < cols; c++) grid[dst + c] = strip[src + c];
    }
  }
  return grid;
}

/**
 * Expand the mask by `radius` pixels in every direction.
 *
 * Thresholding an exact distance field gives round outer corners (rounded
 * joins) and a one pixel anti aliased edge, which a square or diamond
 * structuring element cannot.
 */
export function dilateRound(mask: Mask, radius: number): Mask {
  if (radius < 0.5) return { data: mask.data.slice(), w: mask.w, h: mask.h };
  const d2 = squaredDistanceToShape(mask);
  const out = new Uint8Array(mask.data.length);
  for (let i = 0; i < out.length; i++) {
    const a = radius + 0.5 - Math.sqrt(d2[i]);
    const v = a <= 0 ? 0 : a >= 1 ? 255 : (a * 255 + 0.5) | 0;
    out[i] = v > mask.data[i] ? v : mask.data[i];
  }
  return { data: out, w: mask.w, h: mask.h };
}

/**
 * Close every background region that the canvas border cannot reach.
 *
 * An icon like an infinity loop or a letter O leaves enclosed pockets in the
 * front face. Without this, the sweep is visible through them and the icon
 * reads as a hollow shell. The flood uses 4 connectivity on the background, so
 * a one pixel diagonal leak still counts as closed.
 */
export function fillEnclosed(mask: Mask): Mask {
  const { data, w, h } = mask;
  const reach = new Uint8Array(w * h);
  const isOpen = (i: number) => data[i] < 128 && reach[i] === 0;

  const stack: number[] = [];
  for (let x = 0; x < w; x++) {
    stack.push(x, (h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    stack.push(y * w, y * w + w - 1);
  }

  while (stack.length) {
    const seed = stack.pop() as number;
    if (!isOpen(seed)) continue;
    const y = (seed / w) | 0;
    const row = y * w;
    let xl = seed - row;
    let xr = xl;
    while (xl > 0 && isOpen(row + xl - 1)) xl--;
    while (xr + 1 < w && isOpen(row + xr + 1)) xr++;
    for (let x = xl; x <= xr; x++) reach[row + x] = 1;

    for (let dy = -1; dy <= 1; dy += 2) {
      const ny = y + dy;
      if (ny < 0 || ny >= h) continue;
      const nrow = ny * w;
      let x = xl;
      while (x <= xr) {
        while (x <= xr && !isOpen(nrow + x)) x++;
        if (x > xr) break;
        stack.push(nrow + x);
        while (x <= xr && isOpen(nrow + x)) x++;
      }
    }
  }

  const filled = (i: number) => data[i] < 128 && reach[i] === 0;
  const out = data.slice();
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      const v = data[i];
      if (v < 128) {
        if (reach[i] === 0) out[i] = 255;
        continue;
      }
      if (v === 255) continue;
      // a partly transparent pixel between the shape and a filled pocket would
      // show the sweep through as a faint ring, so the rim is made opaque too
      if (
        (x > 0 && filled(i - 1)) ||
        (x + 1 < w && filled(i + 1)) ||
        (y > 0 && filled(i - w)) ||
        (y + 1 < h && filled(i + w))
      ) {
        out[i] = 255;
      }
    }
  }
  return { data: out, w, h };
}

// --------------------------------------------------------------------------
// the parallel sweep
// --------------------------------------------------------------------------
/**
 * out[i] = max(src[i - dir*k] .. src[i]) along `axis`, in place.
 *
 * Sparse table doubling: log2(k) passes instead of k shifted copies, so the
 * swept volume is one solid shape with no banding whatever the depth.
 */
function runningMax(buf: Uint8Array, w: number, h: number, axis: 0 | 1, k: number, dir: 1 | -1) {
  if (k <= 0) return;
  // descending for dir 1 and ascending for dir -1 reads values that have not
  // been overwritten yet, so no scratch copy is needed
  const shiftRow = (s: number) => {
    for (let y = 0; y < h; y++) {
      const base = y * w;
      if (dir === 1) {
        for (let i = w - 1; i >= s; i--) {
          const v = buf[base + i - s];
          if (v > buf[base + i]) buf[base + i] = v;
        }
      } else {
        for (let i = 0; i < w - s; i++) {
          const v = buf[base + i + s];
          if (v > buf[base + i]) buf[base + i] = v;
        }
      }
    }
  };
  // along y the shift is a whole row offset, so the inner loop stays
  // sequential in memory instead of striding down a column
  const shiftCol = (s: number) => {
    const off = s * w;
    if (dir === 1) {
      for (let y = h - 1; y >= s; y--) {
        const a = y * w;
        const b = a - off;
        for (let x = 0; x < w; x++) {
          const v = buf[b + x];
          if (v > buf[a + x]) buf[a + x] = v;
        }
      }
    } else {
      for (let y = 0; y < h - s; y++) {
        const a = y * w;
        const b = a + off;
        for (let x = 0; x < w; x++) {
          const v = buf[b + x];
          if (v > buf[a + x]) buf[a + x] = v;
        }
      }
    }
  };

  const shift = axis === 1 ? shiftRow : shiftCol;
  let len = 1;
  while (len * 2 <= k + 1) {
    shift(len);
    len *= 2;
  }
  const rem = k + 1 - len;
  if (rem > 0) shift(rem);
}

/** Normalized sweep depth: 0 on the front face, 255 at the far end. */
function depthMap(src: Uint8Array, w: number, h: number, axis: 0 | 1, k: number, dir: 1 | -1) {
  const out = new Uint8Array(w * h);
  if (k <= 0) return out;
  const scale = 255 / k;

  if (axis === 1) {
    for (let y = 0; y < h; y++) {
      const base = y * w;
      let last = -1;
      if (dir === 1) {
        for (let x = 0; x < w; x++) {
          if (src[base + x] >= 128) last = x;
          const d = last < 0 ? k : Math.min(x - last, k);
          out[base + x] = (d * scale + 0.5) | 0;
        }
      } else {
        last = -1;
        for (let x = w - 1; x >= 0; x--) {
          if (src[base + x] >= 128) last = x;
          const d = last < 0 ? k : Math.min(last - x, k);
          out[base + x] = (d * scale + 0.5) | 0;
        }
      }
    }
    return out;
  }

  // along y, carry one "last row that was inside the shape" per column, so the
  // scan still walks memory in order
  const last = new Int32Array(w).fill(-1);
  if (dir === 1) {
    for (let y = 0; y < h; y++) {
      const base = y * w;
      for (let x = 0; x < w; x++) {
        if (src[base + x] >= 128) last[x] = y;
        const d = last[x] < 0 ? k : Math.min(y - last[x], k);
        out[base + x] = (d * scale + 0.5) | 0;
      }
    }
  } else {
    for (let y = h - 1; y >= 0; y--) {
      const base = y * w;
      for (let x = 0; x < w; x++) {
        if (src[base + x] >= 128) last[x] = y;
        const d = last[x] < 0 ? k : Math.min(last[x] - y, k);
        out[base + x] = (d * scale + 0.5) | 0;
      }
    }
  }
  return out;
}

/** Shear along one axis with linear interpolation. m = 0 is a pure copy. */
function shear(
  src: Uint8Array,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
  axis: 0 | 1,
  m: number,
  pad: number,
  forward: boolean
): Uint8Array {
  const out = new Uint8Array(dw * dh);

  if (m === 0) {
    // multiples of 90 degrees: the shear is a pure translation, so copy rows
    // instead of interpolating, which keeps the operation lossless
    const shift = forward ? -pad : pad;
    if (axis === 1) {
      for (let y = 0; y < dh; y++) {
        const sy = y + shift;
        if (sy < 0 || sy >= sh) continue;
        const n = Math.min(sw, dw);
        out.set(src.subarray(sy * sw, sy * sw + n), y * dw);
      }
    } else {
      for (let y = 0; y < Math.min(dh, sh); y++) {
        const from = Math.max(0, -shift);
        const to = Math.min(dw, sw - shift);
        if (to <= from) continue;
        out.set(src.subarray(y * sw + from + shift, y * sw + to + shift), y * dw + from);
      }
    }
    return out;
  }

  // forward maps source (x, y) to (x, y - m*x + pad) for axis 1, and
  // (x - m*y + pad, y) for axis 0. Both are inverted by sampling the source at
  // the matching offset, so only the sign of the offset changes.
  const sign = forward ? 1 : -1;
  const off = forward ? -pad : pad;

  if (axis === 1) {
    for (let y = 0; y < dh; y++) {
      const drow = y * dw;
      for (let x = 0; x < dw; x++) {
        const sy = y + sign * m * x + off;
        const y0 = Math.floor(sy);
        const fy = sy - y0;
        const a = y0 >= 0 && y0 < sh && x < sw ? src[y0 * sw + x] : 0;
        const b = y0 + 1 >= 0 && y0 + 1 < sh && x < sw ? src[(y0 + 1) * sw + x] : 0;
        out[drow + x] = (a + (b - a) * fy + 0.5) | 0;
      }
    }
  } else {
    for (let y = 0; y < dh; y++) {
      const drow = y * dw;
      const srow = y < sh ? y * sw : -1;
      for (let x = 0; x < dw; x++) {
        const sx = x + sign * m * y + off;
        const x0 = Math.floor(sx);
        const fx = sx - x0;
        const a = srow >= 0 && x0 >= 0 && x0 < sw ? src[srow + x0] : 0;
        const b = srow >= 0 && x0 + 1 >= 0 && x0 + 1 < sw ? src[srow + x0 + 1] : 0;
        out[drow + x] = (a + (b - a) * fx + 0.5) | 0;
      }
    }
  }
  return out;
}

export type Sweep = { ext: Uint8Array; depth: Uint8Array };

/**
 * Union of the mask translated by d * (cos a, sin a) for every d in [0, depth].
 *
 * y points down, so angle 90 sweeps straight down. The sweep runs in a sheared
 * frame where the direction is axis aligned, which keeps the running maximum
 * exact and the edges hard. At multiples of 90 degrees the shear is the
 * identity and the whole operation is lossless.
 */
export function sweepMask(mask: Mask, angleDeg: number, depth: number): Sweep {
  const { w, h } = mask;
  if (depth < 0.5) {
    return { ext: mask.data.slice(), depth: new Uint8Array(w * h) };
  }
  const a = (angleDeg * Math.PI) / 180;
  let ux = Math.cos(a);
  let uy = Math.sin(a);
  if (Math.abs(ux) < 1e-9) ux = 0;
  if (Math.abs(uy) < 1e-9) uy = 0;

  const horizontal = Math.abs(ux) >= Math.abs(uy);
  const axis: 0 | 1 = horizontal ? 1 : 0;
  const m = horizontal ? uy / ux : ux / uy;
  const span = horizontal ? w : h;
  const padA = Math.ceil(Math.max(0, m) * span) + 2;
  const padB = Math.ceil(Math.max(0, -m) * span) + 2;
  const k = Math.round(Math.abs(horizontal ? ux : uy) * depth);
  const dir: 1 | -1 = (horizontal ? ux : uy) > 0 ? 1 : -1;

  const sw = horizontal ? w : w + padA + padB;
  const sh = horizontal ? h + padA + padB : h;

  const sheared = shear(mask.data, w, h, sw, sh, axis, m, padA, true);
  const tmap = depthMap(sheared, sw, sh, axis, k, dir);
  runningMax(sheared, sw, sh, axis, k, dir);

  const ext = shear(sheared, sw, sh, w, h, axis, m, padA, false);
  const dep = shear(tmap, sw, sh, w, h, axis, m, padA, false);
  for (let i = 0; i < ext.length; i++) if (mask.data[i] > ext[i]) ext[i] = mask.data[i];
  return { ext, depth: dep };
}

// --------------------------------------------------------------------------
// resampling
// --------------------------------------------------------------------------
/** Box filter resize, used both to place the logo and to fold the
 *  supersampled buffers back down to the canvas size. */
export function resizeArea(
  src: Uint8Array,
  sw: number,
  sh: number,
  dw: number,
  dh: number
): Uint8Array {
  if (sw === dw && sh === dh) return src.slice();
  const out = new Uint8Array(dw * dh);

  // folding a supersampled buffer back down is an exact integer ratio, which
  // is the common case and worth its own loop
  if (sw % dw === 0 && sh % dh === 0) {
    const bx = sw / dw;
    const by = sh / dh;
    const inv = 1 / (bx * by);
    for (let y = 0; y < dh; y++) {
      const y0 = y * by;
      const orow = y * dw;
      for (let x = 0; x < dw; x++) {
        let sum = 0;
        const x0 = x * bx;
        for (let yy = 0; yy < by; yy++) {
          const row = (y0 + yy) * sw + x0;
          for (let xx = 0; xx < bx; xx++) sum += src[row + xx];
        }
        out[orow + x] = (sum * inv + 0.5) | 0;
      }
    }
    return out;
  }

  const xs = sw / dw;
  const ys = sh / dh;
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * ys);
    const y1 = Math.min(sh, Math.max(y0 + 1, Math.ceil((y + 1) * ys)));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * xs);
      const x1 = Math.min(sw, Math.max(x0 + 1, Math.ceil((x + 1) * xs)));
      let sum = 0;
      let count = 0;
      for (let yy = y0; yy < y1; yy++) {
        const row = yy * sw;
        for (let xx = x0; xx < x1; xx++) {
          sum += src[row + xx];
          count++;
        }
      }
      out[y * dw + x] = count ? (sum / count + 0.5) | 0 : 0;
    }
  }
  return out;
}

// --------------------------------------------------------------------------
// gradients and shading
// --------------------------------------------------------------------------
export function gradientLut(stops: { pos: number; color: string }[], n = 1024): Uint8Array {
  const lut = new Uint8Array(n * 3);
  const pts = stops.map((s) => ({ pos: s.pos, rgb: hexToRgb(s.color) }));
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    let j = 0;
    while (j < pts.length - 2 && t > pts[j + 1].pos) j++;
    const a = pts[j];
    const b = pts[Math.min(j + 1, pts.length - 1)];
    const span = b.pos - a.pos;
    const f = span <= 1e-6 ? 0 : Math.min(1, Math.max(0, (t - a.pos) / span));
    lut[i * 3] = a.rgb[0] + (b.rgb[0] - a.rgb[0]) * f;
    lut[i * 3 + 1] = a.rgb[1] + (b.rgb[1] - a.rgb[1]) * f;
    lut[i * 3 + 2] = a.rgb[2] + (b.rgb[2] - a.rgb[2]) * f;
  }
  return lut;
}

/**
 * Inverse distance field: every color owns an anchor in the unit box and each
 * cell mixes them by 1 / distance^(2 * sharpness).
 *
 * It is baked into a small grid and sampled bilinearly by the renderer, since
 * the field is smooth: 128 by 128 cells cost nothing and a per pixel solve
 * over nine million pixels would.
 */
export function gradientField(
  anchors: { x: number; y: number; color: string }[],
  size: number,
  sharpness: number
): Uint8Array {
  const out = new Uint8Array(size * size * 3);
  const pts = anchors.map((a) => ({
    x: Math.min(1, Math.max(0, a.x)),
    y: Math.min(1, Math.max(0, a.y)),
    rgb: hexToRgb(a.color),
  }));
  if (!pts.length) return out;
  const power = Math.max(0.25, sharpness);

  for (let j = 0; j < size; j++) {
    const v = (j + 0.5) / size;
    for (let i = 0; i < size; i++) {
      const u = (i + 0.5) / size;
      let wsum = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      let exact = -1;
      for (let k = 0; k < pts.length; k++) {
        const dx = u - pts[k].x;
        const dy = v - pts[k].y;
        const d2 = dx * dx + dy * dy;
        if (d2 < 1e-9) {
          exact = k;
          break;
        }
        const w = 1 / Math.pow(d2, power);
        wsum += w;
        r += w * pts[k].rgb[0];
        g += w * pts[k].rgb[1];
        b += w * pts[k].rgb[2];
      }
      const o = (j * size + i) * 3;
      if (exact >= 0) {
        out[o] = pts[exact].rgb[0];
        out[o + 1] = pts[exact].rgb[1];
        out[o + 2] = pts[exact].rgb[2];
      } else {
        out[o] = r / wsum + 0.5;
        out[o + 1] = g / wsum + 0.5;
        out[o + 2] = b / wsum + 0.5;
      }
    }
  }
  return out;
}

export type ShadingRamps = { value: Float32Array; sat: Float32Array; edge: Float32Array };

/**
 * Sampled over the normalized sweep depth:
 *   value  lowers HSV V, by extrusionDarken everywhere plus shadingStrength
 *          ramped toward the far end. This is what separates the side face
 *          from the front face, including at the bottom of the icon where the
 *          two would otherwise share a color.
 *   sat    raises HSV S in step with the darkening, so the dark end stays a
 *          shade of the same color instead of turning gray.
 *   edge   blend amount of the edge accent near the fold.
 */
export function shadingRamps(opts: {
  shadingEnabled: boolean;
  extrusionDarken: number;
  shadingStrength: number;
  shadingSaturation: number;
  smoothness: number;
  highlightSize: number;
  highlightStrength: number;
}): ShadingRamps {
  const value = new Float32Array(256).fill(1);
  const sat = new Float32Array(256).fill(1);
  const edge = new Float32Array(256);
  if (!opts.shadingEnabled) return { value, sat, edge };

  const maxDrop = Math.max(
    1e-6,
    1 - (1 - opts.extrusionDarken) * (1 - opts.shadingStrength)
  );
  const power = 1 + 2 * Math.min(1, Math.max(0, opts.smoothness / 100));

  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    const ramp = ease(t, opts.smoothness);
    const v = (1 - opts.extrusionDarken) * (1 - opts.shadingStrength * ramp);
    value[i] = v;
    sat[i] = 1 + opts.shadingSaturation * ((1 - v) / maxDrop);
    if (opts.highlightSize > 0 && opts.highlightStrength !== 0) {
      // The accent must start fading the moment it leaves the front face. An S
      // curve would hold full strength for the first pixels and read as a
      // drawn stripe along the fold, so the falloff is a power curve: steepest
      // at the fold, flat where it reaches zero.
      const falloff = Math.min(1, Math.max(0, (opts.highlightSize - t) / opts.highlightSize));
      edge[i] = opts.highlightStrength * Math.pow(falloff, power);
    }
  }
  return { value, sat, edge };
}
