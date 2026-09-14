"""The renderer.

render(svg, params) -> RGBA uint8 array.  No UI code here on purpose: the CLI,
the web server and any batch pipeline all call this same function.

Layer order, bottom to top:
    1. extrusion            (swept copy of the front face, shaded)
    2. front face           (silhouette expanded by stroke_width, gradient)
    3. logo                 (original SVG silhouette, flat color)
"""

from __future__ import annotations

import hashlib
import math
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

import cv2
import numpy as np

from . import ops
from .params import RenderParams
from .svgload import load_logo_mask, logo_aspect, read_svg

_MASK_CACHE: "OrderedDict[Tuple[str, int], np.ndarray]" = OrderedDict()
_MASK_CACHE_MAX = 6


@dataclass
class RenderResult:
    image: np.ndarray                      # (S, S, 4) uint8 RGBA
    layout: Dict[str, Any] = field(default_factory=dict)
    warnings: List[str] = field(default_factory=list)


# --------------------------------------------------------------------------
def _cached_mask(svg_bytes: bytes, content_px: float) -> np.ndarray:
    bucket = int(math.ceil(max(64.0, content_px) / 256.0) * 256)
    key = (hashlib.sha1(svg_bytes).hexdigest(), bucket)
    hit = _MASK_CACHE.get(key)
    if hit is not None:
        _MASK_CACHE.move_to_end(key)
        return hit
    mask = load_logo_mask(svg_bytes, bucket)
    _MASK_CACHE[key] = mask
    while len(_MASK_CACHE) > _MASK_CACHE_MAX:
        _MASK_CACHE.popitem(last=False)
    return mask


def clear_cache() -> None:
    _MASK_CACHE.clear()


# --------------------------------------------------------------------------
def compute_layout(mask_h: int, mask_w: int, p: RenderParams) -> Dict[str, Any]:
    """Place the artwork so that border and extrusion are always inside the
    canvas.  Lengths are already in canvas pixels (call params.scaled first)."""
    size = float(p.canvas_size)
    pad = float(p.padding)
    stroke = max(0.0, float(p.stroke_width))
    depth = max(0.0, float(p.extrusion_depth)) if p.extrusion_enabled else 0.0

    a = math.radians(float(p.extrusion_angle))
    ux, uy = math.cos(a), math.sin(a)
    ext_x, ext_y = abs(ux) * depth, abs(uy) * depth

    avail = max(16.0, size - 2.0 * pad)
    longest = float(max(mask_w, mask_h))
    ar_w, ar_h = mask_w / longest, mask_h / longest

    warnings: List[str] = []
    if p.fit_mode == "front":
        limits = [(avail - 2 * stroke) / ar_w, (avail - 2 * stroke) / ar_h,
                  (size - 2 * stroke - 2 * ext_x) / ar_w,
                  (size - 2 * stroke - 2 * ext_y) / ar_h]
    else:
        limits = [(avail - 2 * stroke - ext_x) / ar_w,
                  (avail - 2 * stroke - ext_y) / ar_h]
    logo_long = min(limits)
    if logo_long < avail * 0.04:
        logo_long = avail * 0.04
        warnings.append("stroke width and extrusion depth nearly fill the canvas; "
                        "the artwork was clamped and may reach into the padding")

    logo_w, logo_h = logo_long * ar_w, logo_long * ar_h
    front_w, front_h = logo_w + 2 * stroke, logo_h + 2 * stroke

    if p.fit_mode == "front":
        front_x = (size - front_w) * 0.5
        front_y = (size - front_h) * 0.5
    else:
        comp_w, comp_h = front_w + ext_x, front_h + ext_y
        front_x = (size - comp_w) * 0.5 + max(0.0, -ux) * depth
        front_y = (size - comp_h) * 0.5 + max(0.0, -uy) * depth

    logo_x, logo_y = front_x + stroke, front_y + stroke
    return {
        "logo": (logo_x, logo_y, logo_w, logo_h),
        "front": (front_x, front_y, front_w, front_h),
        "front_bbox": (front_x, front_y, front_x + front_w, front_y + front_h),
        "extrusion_offset": (ux * depth, uy * depth),
        "warnings": warnings,
    }


# --------------------------------------------------------------------------
def render(source, params: RenderParams) -> RenderResult:
    p = params.scaled()
    size = int(p.canvas_size)
    ss = int(max(1, min(4, p.supersample)))
    work = size * ss

    svg_bytes = read_svg(source)
    # the probe gives the aspect ratio, which is all the layout needs; the real
    # rasterization then happens exactly at the size the layout asked for
    ah, aw = logo_aspect(svg_bytes)
    layout = compute_layout(ah, aw, p)
    need = max(layout["logo"][2], layout["logo"][3]) * ss
    mask_src = _cached_mask(svg_bytes, need)
    layout = compute_layout(mask_src.shape[0], mask_src.shape[1], p)
    warnings = list(layout["warnings"])

    lx, ly, lw, lh = layout["logo"]
    tw, th = max(1, int(round(lw * ss))), max(1, int(round(lh * ss)))
    interp = cv2.INTER_AREA if (tw <= mask_src.shape[1]) else cv2.INTER_CUBIC
    logo_small = cv2.resize(mask_src, (tw, th), interpolation=interp)
    logo_u8 = np.clip(logo_small * 255.0 + 0.5, 0, 255).astype(np.uint8)

    logo_work = np.zeros((work, work), np.uint8)
    ox, oy = int(round(lx * ss)), int(round(ly * ss))
    ox = max(0, min(ox, work - tw))
    oy = max(0, min(oy, work - th))
    logo_work[oy:oy + th, ox:ox + tw] = logo_u8
    del logo_small, logo_u8

    outer_work = ops.dilate_round(logo_work, float(p.stroke_width) * ss)
    if p.fill_holes:
        outer_work = ops.fill_enclosed(outer_work)

    ext_work = t_work = None
    if p.extrusion_enabled and p.extrusion_depth >= 0.5:
        ext_work, t_work = ops.sweep_mask(outer_work, p.extrusion_angle,
                                          float(p.extrusion_depth) * ss)

    # --- down to final resolution ----------------------------------------
    logo_a = ops.downsample(logo_work, size)
    outer_a = ops.downsample(outer_work, size)
    del logo_work, outer_work
    ext_a = t_map = None
    if ext_work is not None:
        # alpha weighted average of t, so edge pixels keep the right shade
        tw_u8 = ((t_work.astype(np.uint16) * ext_work.astype(np.uint16)) // 255).astype(np.uint8)
        ext_a = ops.downsample(ext_work, size)
        t_num = ops.downsample(tw_u8, size).astype(np.float32)
        del tw_u8, t_work, ext_work
        denom = np.maximum(ext_a.astype(np.float32), 1.0)
        t_map = np.clip(t_num * 255.0 / denom, 0, 255).astype(np.uint8)
        del t_num, denom

    # --- colors -----------------------------------------------------------
    stops = p.normalized_stops()
    lut = ops.gradient_lut(stops)
    front_bbox = layout["front_bbox"] if p.gradient_space == "shape" else (0, 0, size, size)

    out_rgb = np.zeros((size, size, 3), np.float32)   # premultiplied
    out_a = np.zeros((size, size), np.float32)

    if ext_a is not None:
        shade_kw = dict(
            shading_enabled=bool(p.shading_enabled),
            extrusion_darken=float(p.extrusion_darken),
            shading_strength=float(p.shading_strength),
            shading_saturation=float(p.shading_saturation),
            smoothness=float(p.smoothness),
            highlight_size=float(p.highlight_size),
            highlight_strength=float(p.highlight_strength),
        )
        factor, sat, hl_amount = ops.shading_ramps(**shade_kw)
        if p.extrusion_mode() == "gradient":
            # A swept pixel at p came from the front face pixel p - d * u, so
            # its gradient position is the one at p shifted back along the
            # sweep.  The gradient is linear, so that shift is a constant.
            gx, gy, extent, _, _ = ops.gradient_axis(front_bbox, p.gradient_angle)
            a = math.radians(float(p.extrusion_angle))
            shift = float(p.extrusion_depth) * (math.cos(a) * gx + math.sin(a) * gy) / extent
            tg = ops.gradient_param((size, size), front_bbox, p.gradient_angle)
            tg -= (t_map.astype(np.float32) / 255.0) * shift
            ext_rgb = ops.apply_lut(tg, lut).astype(np.float32)
            del tg
            ext_rgb = ops.saturate(ext_rgb, sat[t_map][:, :, None])
            ext_rgb *= factor[t_map][:, :, None]
            amount = hl_amount[t_map]
            if amount.any():
                hl = np.array(ops.hex_to_rgb(p.highlight_color), np.float32)
                ext_rgb *= (1.0 - amount)[:, :, None]
                ext_rgb += hl * amount[:, :, None]
            del amount
        else:
            shade = ops.shading_lut(ops.hex_to_rgb(p.resolved_extrusion_color()),
                                    highlight_color=p.highlight_color, **shade_kw)
            ext_rgb = shade[t_map].astype(np.float32)
        ops.over_premul(out_rgb, out_a, ext_rgb, ext_a.astype(np.float32) / 255.0)
        del ext_rgb, t_map, ext_a

    grad = ops.gradient_image((size, size), front_bbox, p.gradient_angle, lut)
    ops.over_premul(out_rgb, out_a, grad.astype(np.float32),
                    outer_a.astype(np.float32) / 255.0)
    del grad, outer_a

    if p.logo_enabled:
        ops.over_premul(out_rgb, out_a, None, logo_a.astype(np.float32) / 255.0,
                        flat_color=ops.hex_to_rgb(p.logo_color))
    del logo_a

    rgba = np.empty((size, size, 4), np.uint8)
    straight = ops.unpremultiply(out_rgb, out_a)
    rgba[:, :, :3] = np.clip(straight + 0.5, 0, 255).astype(np.uint8)
    rgba[:, :, 3] = np.clip(out_a * 255.0 + 0.5, 0, 255).astype(np.uint8)
    return RenderResult(image=rgba, layout=layout, warnings=warnings)


# --------------------------------------------------------------------------
def save_png(image: np.ndarray, path: str) -> None:
    from PIL import Image
    Image.fromarray(image, mode="RGBA").save(path, format="PNG", optimize=True)


def encode_png(image: np.ndarray) -> bytes:
    import io
    from PIL import Image
    buf = io.BytesIO()
    Image.fromarray(image, mode="RGBA").save(buf, format="PNG")
    return buf.getvalue()
