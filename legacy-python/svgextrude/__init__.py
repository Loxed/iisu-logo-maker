"""svgextrude: thick outline + gradient + parallel 3D extrusion for SVG icons."""

from .params import RenderParams, default_params, load_preset, load_presets
from .render import RenderResult, render, save_png, encode_png, clear_cache

__version__ = "1.0.0"
__all__ = [
    "RenderParams", "RenderResult", "render", "save_png", "encode_png",
    "default_params", "load_preset", "load_presets", "clear_cache",
]
