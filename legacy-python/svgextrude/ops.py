"""Mask, sweep, gradient and shading primitives.

Masks are uint8 (0..255) single channel images used as alpha.  Everything here
is deterministic: no random jitter, no blur, no drop shadow.
"""

from __future__ import annotations

import math
from typing import List, Optional, Sequence, Tuple

import cv2
import numpy as np


# --------------------------------------------------------------------------
# colors
# --------------------------------------------------------------------------
def hex_to_rgb(value: str) -> Tuple[float, float, float]:
    s = str(value).strip().lstrip("#")
    if len(s) == 3:
        s = "".join(c * 2 for c in s)
    if len(s) == 8:
        s = s[:6]
    if len(s) != 6:
        raise ValueError(f"bad color {value!r}")
    return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))


def rgb_to_hex(rgb: Sequence[float]) -> str:
    return "#{:02X}{:02X}{:02X}".format(*[int(round(max(0, min(255, c)))) for c in rgb])


# --------------------------------------------------------------------------
# easing
# --------------------------------------------------------------------------
def smootherstep(t: np.ndarray) -> np.ndarray:
    t = np.clip(t, 0.0, 1.0)
    return t * t * t * (t * (t * 6.0 - 15.0) + 10.0)


def ease(t: np.ndarray, smoothness: float) -> np.ndarray:
    """smoothness 0 -> linear ramp, 100 -> fully eased S curve."""
    s = float(np.clip(smoothness / 100.0, 0.0, 1.0))
    t = np.clip(t, 0.0, 1.0)
    if s <= 0.0:
        return t
    return (1.0 - s) * t + s * smootherstep(t)


# --------------------------------------------------------------------------
# outside stroke = dilation with a round structuring element
# --------------------------------------------------------------------------
def dilate_round(mask: np.ndarray, radius: float) -> np.ndarray:
    """Expand mask by `radius` pixels in every direction.

    Implemented as a Euclidean distance field threshold, which gives exactly
    round outer corners (rounded joins) and a one pixel anti-aliased edge.
    """
    if radius < 0.5:
        return mask.copy()
    src = np.where(mask >= 128, np.uint8(0), np.uint8(255))
    dist = cv2.distanceTransform(src, cv2.DIST_L2, cv2.DIST_MASK_PRECISE)
    alpha = np.clip(radius + 0.5 - dist, 0.0, 1.0)
    out = (alpha * 255.0 + 0.5).astype(np.uint8)
    np.maximum(out, mask, out=out)
    return out


def fill_enclosed(mask: np.ndarray) -> np.ndarray:
    """Close every background region the canvas border cannot reach.

    An icon like an infinity loop or a letter O leaves enclosed pockets in the
    front face, and without this the sweep shows through them, so the icon
    reads as a hollow shell.
    """
    h, w = mask.shape
    solid = np.zeros((h + 2, w + 2), np.uint8)
    solid[1:-1, 1:-1] = np.where(mask >= 128, 255, 0)
    background = 255 - solid
    ff = np.zeros((h + 4, w + 4), np.uint8)
    cv2.floodFill(background, ff, (0, 0), 0)          # reachable background -> 0
    holes = background[1:-1, 1:-1] > 0
    if not holes.any():
        return mask.copy()

    out = mask.copy()
    out[holes] = 255
    # a partly transparent pixel between the shape and a filled pocket would
    # show the sweep through as a faint ring, so the rim is made opaque too
    near = cv2.dilate(holes.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
    rim = (mask >= 128) & (mask < 255) & near
    out[rim] = 255
    return out


# --------------------------------------------------------------------------
# parallel sweep (the extrusion)
# --------------------------------------------------------------------------
def _axis_slices(axis: int, n: int) -> Tuple[tuple, tuple, tuple]:
    head = [slice(None), slice(None)]
    tail = [slice(None), slice(None)]
    zero = [slice(None), slice(None)]
    head[axis] = slice(n, None)
    tail[axis] = slice(None, -n)
    zero[axis] = slice(None, n)
    return tuple(head), tuple(tail), tuple(zero)


def _backward_max(a: np.ndarray, k: int, axis: int) -> np.ndarray:
    """out[i] = max(a[i-k .. i]) along `axis`, zero padded before the start.

    Sparse table doubling: O(log k) full array passes instead of k shifts, so
    the swept volume is one solid shape with no banding whatever the depth.
    """
    if k <= 0:
        return a.copy()
    out = a.copy()
    scratch = np.empty_like(out)
    length = 1
    while length * 2 <= k + 1:
        head, tail, zero = _axis_slices(axis, length)
        scratch[zero] = 0
        scratch[head] = out[tail]
        np.maximum(out, scratch, out=out)
        length *= 2
    rem = (k + 1) - length
    if rem > 0:
        head, tail, zero = _axis_slices(axis, rem)
        scratch[zero] = 0
        scratch[head] = out[tail]
        np.maximum(out, scratch, out=out)
    return out


def _depth_map(mask: np.ndarray, k: int, axis: int) -> np.ndarray:
    """Normalized sweep parameter t = d / k, where d is the number of pixels
    back along the sweep to the first pixel of the source shape.  0 on the
    front face, 255 at the far end of the sweep."""
    h, w = mask.shape
    if k <= 0:
        return np.zeros((h, w), np.uint8)
    n = mask.shape[axis]
    idx = np.arange(n, dtype=np.int32)
    idx = idx[None, :] if axis == 1 else idx[:, None]
    out = np.empty((h, w), np.uint8)
    other = w if axis == 0 else h
    block = max(1, 8_000_000 // max(n, 1))
    scale = 255.0 / float(k)
    for i0 in range(0, other, block):
        sl = (slice(None), slice(i0, i0 + block)) if axis == 0 else \
             (slice(i0, i0 + block), slice(None))
        blk = mask[sl]
        pos = np.where(blk >= 128, idx, np.int32(-1))
        np.maximum.accumulate(pos, axis=axis, out=pos)
        d = idx - pos
        d[pos < 0] = k
        np.clip(d, 0, k, out=d)
        out[sl] = (d * scale + 0.5).astype(np.uint8)
    return out


def sweep_mask(mask: np.ndarray, angle_deg: float, depth: float
               ) -> Tuple[np.ndarray, np.ndarray]:
    """Union of mask translated by d * (cos a, sin a) for every d in [0, depth].

    y points down, so angle 90 sweeps straight down.  Returns the swept alpha
    (which contains the original mask) and the normalized depth map used for
    shading.

    The sweep is done in a sheared frame where the direction is axis aligned,
    so the running maximum is exact and the result has hard geometric edges.
    For angles that are multiples of 90 degrees the shear is the identity and
    the whole operation is lossless.
    """
    h, w = mask.shape
    if depth < 0.5:
        return mask.copy(), np.zeros((h, w), np.uint8)

    a = math.radians(float(angle_deg))
    ux, uy = math.cos(a), math.sin(a)
    if abs(ux) < 1e-9:
        ux = 0.0
    if abs(uy) < 1e-9:
        uy = 0.0

    horizontal = abs(ux) >= abs(uy)
    if horizontal:
        m = uy / ux
        pad = int(math.ceil(max(0.0, m) * w)) + 2            # extra rows on top
        pad_b = int(math.ceil(max(0.0, -m) * w)) + 2
        fwd = np.float32([[1.0, 0.0, 0.0], [-m, 1.0, pad]])
        inv = np.float32([[1.0, 0.0, 0.0], [m, 1.0, -pad]])
        dsize = (w, h + pad + pad_b)
        k = int(round(abs(ux) * depth))
        axis, flip = 1, ux < 0
    else:
        m = ux / uy
        pad = int(math.ceil(max(0.0, m) * h)) + 2            # extra cols on left
        pad_b = int(math.ceil(max(0.0, -m) * h)) + 2
        fwd = np.float32([[1.0, -m, pad], [0.0, 1.0, 0.0]])
        inv = np.float32([[1.0, m, -pad], [0.0, 1.0, 0.0]])
        dsize = (w + pad + pad_b, h)
        k = int(round(abs(uy) * depth))
        axis, flip = 0, uy < 0

    identity = abs(m) < 1e-9 and pad == 2 and pad_b == 2
    sheared = cv2.warpAffine(mask, fwd, dsize, flags=cv2.INTER_LINEAR,
                             borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    if flip:
        sheared = np.ascontiguousarray(sheared[::-1] if axis == 0 else sheared[:, ::-1])

    swept = _backward_max(sheared, k, axis)
    tmap = _depth_map(sheared, k, axis)
    del sheared

    if flip:
        swept = np.ascontiguousarray(swept[::-1] if axis == 0 else swept[:, ::-1])
        tmap = np.ascontiguousarray(tmap[::-1] if axis == 0 else tmap[:, ::-1])

    if identity:
        # pure translation: crop instead of warping back
        if axis == 0:
            ext = np.ascontiguousarray(swept[:, pad:pad + w])
            tex = np.ascontiguousarray(tmap[:, pad:pad + w])
        else:
            ext = np.ascontiguousarray(swept[pad:pad + h])
            tex = np.ascontiguousarray(tmap[pad:pad + h])
    else:
        ext = cv2.warpAffine(swept, inv, (w, h), flags=cv2.INTER_LINEAR,
                             borderMode=cv2.BORDER_CONSTANT, borderValue=0)
        tex = cv2.warpAffine(tmap, inv, (w, h), flags=cv2.INTER_LINEAR,
                             borderMode=cv2.BORDER_CONSTANT, borderValue=255)
    np.maximum(ext, mask, out=ext)
    return ext, tex


# --------------------------------------------------------------------------
# gradients
# --------------------------------------------------------------------------
def gradient_lut(stops: Sequence[Tuple[float, str]], n: int = 1024) -> np.ndarray:
    pos = np.array([float(p) for p, _ in stops], dtype=np.float32)
    cols = np.array([hex_to_rgb(c) for _, c in stops], dtype=np.float32)
    t = np.linspace(0.0, 1.0, n, dtype=np.float32)
    lut = np.empty((n, 3), np.float32)
    for ch in range(3):
        lut[:, ch] = np.interp(t, pos, cols[:, ch])
    return np.clip(lut + 0.5, 0, 255).astype(np.uint8)


def gradient_axis(bbox: Tuple[float, float, float, float], angle_deg: float
                  ) -> Tuple[float, float, float, float, float]:
    """(gx, gy, extent, cx, cy) for a linear gradient spanning bbox."""
    x0, y0, x1, y1 = bbox
    a = math.radians(float(angle_deg))
    gx, gy = math.cos(a), math.sin(a)
    extent = abs(gx) * max(x1 - x0, 1e-6) + abs(gy) * max(y1 - y0, 1e-6)
    return gx, gy, extent, (x0 + x1) * 0.5, (y0 + y1) * 0.5


def gradient_param(shape: Tuple[int, int], bbox: Tuple[float, float, float, float],
                   angle_deg: float) -> np.ndarray:
    """Gradient position t in [0, 1] for every pixel (90 = top to bottom)."""
    h, w = shape
    gx, gy, extent, cx, cy = gradient_axis(bbox, angle_deg)
    xs = (np.arange(w, dtype=np.float32) - cx) * (gx / extent)
    ys = (np.arange(h, dtype=np.float32) - cy) * (gy / extent)
    return (xs[None, :] + ys[:, None]) + np.float32(0.5)


def apply_lut(t: np.ndarray, lut: np.ndarray) -> np.ndarray:
    n = lut.shape[0]
    idx = np.clip(t * (n - 1), 0, n - 1).astype(np.uint16)
    return lut[idx]


def gradient_image(shape: Tuple[int, int], bbox: Tuple[float, float, float, float],
                   angle_deg: float, lut: np.ndarray) -> np.ndarray:
    """Linear gradient spanning bbox along `angle_deg` (90 = top to bottom)."""
    return apply_lut(gradient_param(shape, bbox, angle_deg), lut)


def saturate(rgb: np.ndarray, scale) -> np.ndarray:
    """Scale HSV saturation by `scale`, keeping hue and value.

    S is (V - min) / V with V the largest channel, so pushing every channel
    away from the largest one by the same ratio scales S exactly, without a
    round trip through an HSV colorspace.
    """
    mx = rgb.max(axis=-1, keepdims=True)
    return np.clip(mx - (mx - rgb) * scale, 0.0, 255.0)


def shading_ramps(*, shading_enabled: bool, shading_strength: float,
                  smoothness: float, highlight_size: float,
                  highlight_strength: float, extrusion_darken: float = 0.0,
                  shading_saturation: float = 0.0
                  ) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(value factor, saturation scale, highlight amount) over the sweep depth.

    All three are 256 entry ramps indexed by the normalized depth t, so they
    apply the same way to a flat extrusion color and to one that inherits the
    front face gradient.

    value factor    lowers V: extrusion_darken everywhere, plus shading_strength
                    ramped from the fold to the far end.  This is what separates
                    the side face from the front face, including at the bottom
                    of the icon where the two would otherwise share a color.
    saturation      raises S in step with the darkening, so the dark end reads
                    as a shade of the same color instead of a gray.
    """
    t = np.linspace(0.0, 1.0, 256, dtype=np.float32)
    factor = np.ones(256, np.float32)
    sat = np.ones(256, np.float32)
    amount = np.zeros(256, np.float32)
    if shading_enabled:
        ramp = ease(t, smoothness)
        factor = (1.0 - float(extrusion_darken)) * (1.0 - float(shading_strength) * ramp)
        drop = 1.0 - factor
        max_drop = max(float(drop[-1]), 1e-6)
        sat = 1.0 + float(shading_saturation) * (drop / max_drop)
        if highlight_size > 0.0 and highlight_strength != 0.0:
            # The highlight must start fading the moment it leaves the front
            # face.  An S curve would hold full strength for the first pixels
            # and read as a drawn stripe along the fold, so the falloff is a
            # power curve: slope -p at the front, flat where it reaches zero.
            falloff = np.clip((float(highlight_size) - t) / float(highlight_size), 0.0, 1.0)
            power = 1.0 + 2.0 * float(np.clip(smoothness / 100.0, 0.0, 1.0))
            amount = float(highlight_strength) * falloff ** power
    return (factor.astype(np.float32), sat.astype(np.float32), amount.astype(np.float32))


def shading_lut(base_rgb: Sequence[float], **kwargs) -> np.ndarray:
    """256 entry color ramp indexed by the normalized sweep depth."""
    highlight_color = kwargs.pop("highlight_color", "#FFFFFF")
    factor, sat, amount = shading_ramps(**kwargs)
    base = np.array(base_rgb, dtype=np.float32)[None, :]
    rgb = np.repeat(base, 256, axis=0)
    rgb = saturate(rgb, sat[:, None])
    rgb = rgb * factor[:, None]
    if amount.any():
        hl = np.array(hex_to_rgb(highlight_color), dtype=np.float32)[None, :]
        a = amount[:, None]
        rgb = rgb * (1.0 - a) + hl * a
    return np.clip(rgb + 0.5, 0, 255).astype(np.uint8)


# --------------------------------------------------------------------------
# compositing
# --------------------------------------------------------------------------
def over_premul(dst_rgb: np.ndarray, dst_a: np.ndarray,
                src_rgb: Optional[np.ndarray], src_a: np.ndarray,
                flat_color: Optional[Sequence[float]] = None) -> None:
    """Porter-Duff source-over, in place, on premultiplied float32 buffers.

    dst_rgb holds colour already multiplied by dst_a; one division at the very
    end of the pipeline converts back to straight alpha.  Premultiplied
    accumulation is what keeps edge pixels from picking up a halo of the layer
    underneath.
    """
    inv = 1.0 - src_a
    for c in range(3):
        dst_rgb[:, :, c] *= inv
        if flat_color is not None:
            dst_rgb[:, :, c] += float(flat_color[c]) * src_a
        else:
            dst_rgb[:, :, c] += src_rgb[:, :, c] * src_a
    dst_a *= inv
    dst_a += src_a


def unpremultiply(rgb: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    safe = np.maximum(alpha, 1e-6)[:, :, None]
    return rgb / safe


def downsample(mask: np.ndarray, size: int) -> np.ndarray:
    if mask.shape[0] == size and mask.shape[1] == size:
        return mask
    return cv2.resize(mask, (size, size), interpolation=cv2.INTER_AREA)
