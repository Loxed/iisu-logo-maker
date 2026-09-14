"""Parameter set for the extrusion renderer.

Every length here (stroke_width, extrusion_depth, padding) is expressed in
pixels at the reference canvas size (3000 px by default).  When canvas_size
differs, RenderParams.scaled() multiplies those lengths by
canvas_size / reference_size, so a 600 px preview is a faithful miniature of
the 3000 px export.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field, asdict, replace
from pathlib import Path
from typing import List, Sequence, Tuple, Union

GradientStop = Tuple[float, str]

DEFAULT_GRADIENT: List[GradientStop] = [(0.0, "#2FFF74"), (1.0, "#369052")]


@dataclass
class RenderParams:
    # canvas ---------------------------------------------------------------
    canvas_size: int = 3000
    reference_size: int = 3000          # size the lengths below are quoted at
    scale_with_canvas: bool = True
    padding: float = 200.0              # free margin kept around everything
    supersample: int = 2                # internal oversampling factor

    # original logo --------------------------------------------------------
    logo_color: str = "#FFFFFF"
    logo_enabled: bool = True

    # thick outer border ---------------------------------------------------
    stroke_width: float = 210.0
    fill_holes: bool = False            # close the pockets of the front face
    gradient_stops: List[GradientStop] = field(
        default_factory=lambda: list(DEFAULT_GRADIENT)
    )
    gradient_space: str = "shape"       # "shape" (front-face bbox) or "canvas"
    gradient_angle: float = 90.0        # 90 = top-to-bottom

    # parallel extrusion ---------------------------------------------------
    extrusion_depth: float = 150.0
    extrusion_angle: float = 90.0       # degrees, 90 = straight down
    extrusion_color: str = "auto"       # "auto", "gradient", or a hex color
    extrusion_enabled: bool = True

    # extrusion shading ----------------------------------------------------
    shading_enabled: bool = True
    extrusion_darken: float = 0.15      # V drop applied to the whole extrusion
    shading_strength: float = 0.20      # extra V drop at the far end of the sweep
    shading_saturation: float = 0.10    # S gain that follows the darkening
    smoothness: float = 50.0            # 0 = linear ramp, 100 = fully eased
    highlight_size: float = 0.10        # fraction of the depth that is lit
    highlight_color: str = "#FFFFFF"
    highlight_strength: float = 0.0     # 0 = clean fold; raise for a lit edge

    # framing --------------------------------------------------------------
    fit_mode: str = "composite"         # "composite" or "front"
    align: str = "center"               # reserved, only "center" for now

    # ----------------------------------------------------------------------
    @property
    def scale(self) -> float:
        if not self.scale_with_canvas or self.reference_size <= 0:
            return 1.0
        return self.canvas_size / float(self.reference_size)

    def scaled(self) -> "RenderParams":
        """Return a copy with all lengths converted to actual canvas pixels."""
        s = self.scale
        return replace(
            self,
            stroke_width=self.stroke_width * s,
            extrusion_depth=self.extrusion_depth * s,
            padding=self.padding * s,
            reference_size=self.canvas_size,
            scale_with_canvas=False,
        )

    def normalized_stops(self) -> List[GradientStop]:
        stops = [(float(p), str(c)) for p, c in self.gradient_stops]
        if not stops:
            stops = list(DEFAULT_GRADIENT)
        stops.sort(key=lambda s: s[0])
        if stops[0][0] > 0.0:
            stops.insert(0, (0.0, stops[0][1]))
        if stops[-1][0] < 1.0:
            stops.append((1.0, stops[-1][1]))
        return stops

    def extrusion_mode(self) -> str:
        """flat: one base color shaded by depth.
        gradient: every swept pixel keeps the gradient color of the front face
        pixel it came from, the way a pixel level extrude behaves."""
        return "gradient" if str(self.extrusion_color).strip().lower() == "gradient" else "flat"

    def resolved_extrusion_color(self) -> str:
        if str(self.extrusion_color).strip().lower() in ("", "auto", "gradient"):
            return self.normalized_stops()[-1][1]
        return self.extrusion_color

    # serialization --------------------------------------------------------
    def to_dict(self) -> dict:
        d = asdict(self)
        d["gradient_stops"] = [[float(p), str(c)] for p, c in self.gradient_stops]
        return d

    @classmethod
    def from_dict(cls, data: dict) -> "RenderParams":
        data = dict(data or {})
        # accept the short preset form as well
        top = data.pop("gradient_top", None)
        bottom = data.pop("gradient_bottom", None)
        stops = data.pop("gradient_stops", None)
        if stops is None and (top or bottom):
            stops = [[0.0, top or "#FFFFFF"], [1.0, bottom or top or "#000000"]]
        data.pop("name", None)
        known = {f for f in cls.__dataclass_fields__}
        clean = {k: v for k, v in data.items() if k in known}
        if stops is not None:
            clean["gradient_stops"] = [(float(p), str(c)) for p, c in stops]
        return cls(**clean)


def preset_path() -> Path:
    return Path(__file__).with_name("presets.json")


def load_presets(path: Union[str, Path, None] = None) -> dict:
    p = Path(path) if path else preset_path()
    with open(p, "r", encoding="utf-8") as fh:
        raw = json.load(fh)
    if isinstance(raw, dict):
        raw = [raw]
    return {item.get("name", f"preset{i}"): item for i, item in enumerate(raw)}


def load_preset(name: str, path: Union[str, Path, None] = None) -> RenderParams:
    presets = load_presets(path)
    if name not in presets:
        raise KeyError(f"unknown preset {name!r}; available: {', '.join(presets)}")
    return RenderParams.from_dict(presets[name])


def default_params() -> RenderParams:
    try:
        return load_preset("Green Extruded")
    except Exception:
        return RenderParams()
