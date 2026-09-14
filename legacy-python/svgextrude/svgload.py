"""SVG -> tight anti-aliased alpha mask.

The mask is the union of everything the SVG paints, so holes in the artwork
stay holes.  The viewBox is deliberately not trusted for framing: the file is
rasterized once as a probe, the real ink bounding box is measured, then it is
rasterized again at the resolution that makes that bounding box the requested
pixel size.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
from collections import OrderedDict
from typing import Dict, Optional, Tuple

import numpy as np

PROBE_WIDTH = 512
MAX_RASTER_PX = 12000
ALPHA_EPS = 2.0 / 255.0

_PROBE_CACHE: "OrderedDict[str, Dict[str, float]]" = OrderedDict()
_PROBE_CACHE_MAX = 16


class SvgRenderError(RuntimeError):
    pass


def _png_bytes_to_alpha(data: bytes) -> np.ndarray:
    from PIL import Image
    import io

    img = Image.open(io.BytesIO(data)).convert("RGBA")
    arr = np.asarray(img, dtype=np.float32) / 255.0
    return np.ascontiguousarray(arr[:, :, 3])


def _render_cairo_direct(svg_bytes: bytes, width: int,
                         height: Optional[int]) -> np.ndarray:
    """Read the cairo ARGB32 surface straight out of memory.

    cairosvg.svg2png encodes a PNG that we would immediately decode again; at
    4000 px and up that round trip costs more than the rendering itself.
    """
    from cairosvg.parser import Tree
    from cairosvg.surface import PNGSurface

    tree = Tree(bytestring=svg_bytes)
    inst = PNGSurface(tree, None, 96, output_width=width, output_height=height)
    try:
        surface = inst.cairo
        surface.flush()
        w, h = surface.get_width(), surface.get_height()
        stride = surface.get_stride()
        raw = np.frombuffer(surface.get_data(), dtype=np.uint8)
        raw = raw.reshape(h, stride // 4, 4)[:, :w, :]
        chan = 3 if sys.byteorder == "little" else 0      # ARGB32 is native endian
        alpha = np.ascontiguousarray(raw[:, :, chan]).astype(np.float32) / 255.0
    finally:
        inst.finish()
    return alpha


def _render_cairosvg(svg_bytes: bytes, width: int, height: Optional[int]) -> bytes:
    import cairosvg

    kwargs = {"bytestring": svg_bytes, "output_width": width}
    if height:
        kwargs["output_height"] = height
    return cairosvg.svg2png(**kwargs)


def _render_external(svg_bytes: bytes, width: int, height: Optional[int]) -> bytes:
    """Command line rasterizers, tried in order, for machines without cairo."""
    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "in.svg")
        dst = os.path.join(tmp, "out.png")
        with open(src, "wb") as fh:
            fh.write(svg_bytes)

        candidates = []
        if shutil.which("resvg"):
            cmd = ["resvg", "--width", str(width)]
            if height:
                cmd += ["--height", str(height)]
            candidates.append(cmd + [src, dst])
        if shutil.which("rsvg-convert"):
            cmd = ["rsvg-convert", "-w", str(width)]
            if height:
                cmd += ["-h", str(height)]
            candidates.append(cmd + ["-o", dst, src])
        if shutil.which("inkscape"):
            cmd = ["inkscape", src, "--export-type=png", f"--export-filename={dst}",
                   f"--export-width={width}"]
            if height:
                cmd.append(f"--export-height={height}")
            candidates.append(cmd)

        for cmd in candidates:
            try:
                subprocess.run(cmd, check=True, capture_output=True, timeout=120)
                with open(dst, "rb") as fh:
                    return fh.read()
            except Exception:
                continue
    raise SvgRenderError("no external SVG rasterizer on PATH")


# --------------------------------------------------------------------------
# backends, each returning a float32 alpha plane
# --------------------------------------------------------------------------
def _backend_cairo_direct(svg_bytes: bytes, width: int, height: Optional[int]) -> np.ndarray:
    return _render_cairo_direct(svg_bytes, width, height)


def _backend_cairosvg(svg_bytes: bytes, width: int, height: Optional[int]) -> np.ndarray:
    return _png_bytes_to_alpha(_render_cairosvg(svg_bytes, width, height))


def _backend_resvg_py(svg_bytes: bytes, width: int, height: Optional[int]) -> np.ndarray:
    """resvg through its Python wheel. It carries its own renderer, so it needs
    no system library at all, which is the simplest path on Windows."""
    import resvg_py

    kwargs = {"svg_string": svg_bytes.decode("utf-8", "replace"), "width": int(width)}
    if height:
        kwargs["height"] = int(height)
    return _png_bytes_to_alpha(bytes(resvg_py.svg_to_bytes(**kwargs)))


def _backend_external(svg_bytes: bytes, width: int, height: Optional[int]) -> np.ndarray:
    return _png_bytes_to_alpha(_render_external(svg_bytes, width, height))


_BACKENDS = (
    ("cairosvg (direct surface)", _backend_cairo_direct),
    ("cairosvg", _backend_cairosvg),
    ("resvg-py", _backend_resvg_py),
    ("resvg / rsvg-convert / inkscape", _backend_external),
)
_ACTIVE = None


def rasterize(svg_bytes: bytes, width: int, height: Optional[int] = None) -> np.ndarray:
    """Render the SVG and return its alpha plane as float32 in [0, 1].

    The first backend that works is remembered, so the missing ones are probed
    once instead of on every call.
    """
    global _ACTIVE
    width = int(max(1, min(width, MAX_RASTER_PX)))
    if height:
        height = int(max(1, min(height, MAX_RASTER_PX)))

    if _ACTIVE is not None:
        return _ACTIVE[1](svg_bytes, width, height)

    errors = []
    for name, fn in _BACKENDS:
        try:
            alpha = fn(svg_bytes, width, height)
        except Exception as exc:
            errors.append(f"{name}: {type(exc).__name__} {exc}")
            continue
        _ACTIVE = (name, fn)
        return alpha

    raise SvgRenderError(
        "no SVG rasterizer available. Install one of these:\n"
        "  pip install resvg-py     (self contained, no system library)\n"
        "  pip install cairosvg     (needs the cairo library on the system)\n"
        "details:\n  " + "\n  ".join(errors))


def active_backend() -> str:
    """Name of the rasterizer in use, resolving one if that has not happened."""
    if _ACTIVE is None:
        rasterize(b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4">'
                  b'<rect width="4" height="4"/></svg>', 8)
    return _ACTIVE[0] if _ACTIVE else "none"


def ink_bbox(alpha: np.ndarray, eps: float = ALPHA_EPS) -> Optional[Tuple[int, int, int, int]]:
    rows = np.any(alpha > eps, axis=1)
    cols = np.any(alpha > eps, axis=0)
    if not rows.any() or not cols.any():
        return None
    y0, y1 = int(np.argmax(rows)), int(len(rows) - np.argmax(rows[::-1]))
    x0, x1 = int(np.argmax(cols)), int(len(cols) - np.argmax(cols[::-1]))
    return x0, y0, x1, y1


def read_svg(source) -> bytes:
    if isinstance(source, bytes):
        return source
    if isinstance(source, str) and source.lstrip()[:1] == "<":
        return source.encode("utf-8")
    with open(source, "rb") as fh:
        return fh.read()


def probe(svg_bytes: bytes) -> Dict[str, float]:
    """Cheap low resolution render used only to measure the ink box."""
    key = hashlib.sha1(svg_bytes).hexdigest()
    hit = _PROBE_CACHE.get(key)
    if hit is not None:
        _PROBE_CACHE.move_to_end(key)
        return hit
    small = rasterize(svg_bytes, PROBE_WIDTH)
    box = ink_bbox(small)
    if box is None:
        raise SvgRenderError("the SVG rasterized to an empty image (nothing visible)")
    x0, y0, x1, y1 = box
    h, w = small.shape
    info = {
        "ink_w": float(x1 - x0), "ink_h": float(y1 - y0),
        "raster_w": float(w), "raster_h": float(h),
        # ink size as a fraction of the render width, used to pick the real scale
        "frac_w": (x1 - x0) / float(w), "frac_h": (y1 - y0) / float(w),
    }
    _PROBE_CACHE[key] = info
    while len(_PROBE_CACHE) > _PROBE_CACHE_MAX:
        _PROBE_CACHE.popitem(last=False)
    return info


def logo_aspect(svg_bytes: bytes) -> Tuple[float, float]:
    """(height, width) of the ink box, in arbitrary units."""
    info = probe(svg_bytes)
    return info["ink_h"], info["ink_w"]


def load_logo_mask(source, content_px: float) -> np.ndarray:
    """Rasterize the SVG so its ink bounding box is about content_px on its
    longest side, and return that box cropped out as a float32 alpha mask."""
    svg_bytes = read_svg(source)
    content_px = float(max(8.0, content_px))

    info = probe(svg_bytes)
    longest_frac = max(info["frac_w"], info["frac_h"])
    target_width = int(round(content_px / max(longest_frac, 1e-6)))
    target_width = int(max(PROBE_WIDTH, min(target_width, MAX_RASTER_PX)))

    full = rasterize(svg_bytes, target_width)
    box = ink_bbox(full)
    if box is None:
        raise SvgRenderError("the SVG rasterized to an empty image (nothing visible)")
    x0, y0, x1, y1 = box
    mask = full[y0:y1, x0:x1]
    return np.ascontiguousarray(mask, dtype=np.float32)
