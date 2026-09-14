"""Command line front end.

    python -m svgextrude.cli icon.svg -o icon.png
    python -m svgextrude.cli icons/*.svg --outdir build/ --canvas-size 1024
    python -m svgextrude.cli icon.svg --params tweaked.json -o icon.png
"""

from __future__ import annotations

import argparse
import dataclasses
import glob
import json
import os
import sys
import time
from typing import List, Optional

from .params import RenderParams, default_params, load_preset, load_presets
from .render import render, save_png


def parse_stops(text: str) -> List:
    """'0:#2FFF74,0.5:#31C463,1:#369052' -> [(0.0,'#2FFF74'), ...]"""
    stops = []
    for chunk in text.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        pos, _, color = chunk.partition(":")
        stops.append((float(pos), color.strip()))
    if not stops:
        raise argparse.ArgumentTypeError("no gradient stops parsed")
    return stops


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        prog="svgextrude",
        description="Thick outline + gradient + parallel 3D extrusion for SVG icons.")
    ap.add_argument("inputs", nargs="*", help="SVG files (globs allowed)")
    ap.add_argument("-o", "--output", help="output PNG (single input only)")
    ap.add_argument("--outdir", help="output directory for batch runs")
    ap.add_argument("--suffix", default="", help="appended to each output file name")
    ap.add_argument("--preset", default="Green Extruded")
    ap.add_argument("--presets-file", help="JSON file holding presets")
    ap.add_argument("--list-presets", action="store_true")
    ap.add_argument("--params", help="JSON file of parameters, applied over the preset")
    ap.add_argument("--dump-params", help="write the resolved parameters to this JSON file")

    g = ap.add_argument_group("canvas")
    g.add_argument("--canvas-size", type=int)
    g.add_argument("--padding", type=float)
    g.add_argument("--supersample", type=int, choices=[1, 2, 3, 4])
    g.add_argument("--fit-mode", choices=["composite", "front"])
    g.add_argument("--no-scale-with-canvas", action="store_true",
                   help="treat lengths as literal pixels instead of scaling them "
                        "with canvas_size")

    g = ap.add_argument_group("logo and border")
    g.add_argument("--logo-color")
    g.add_argument("--no-logo", action="store_true")
    g.add_argument("--stroke-width", type=float)
    g.add_argument("--fill-holes", action="store_true",
                   help="close the enclosed pockets of the front face")
    g.add_argument("--gradient-top")
    g.add_argument("--gradient-bottom")
    g.add_argument("--gradient-stops", type=parse_stops,
                   help="'0:#2FFF74,0.5:#31C463,1:#369052'")
    g.add_argument("--gradient-angle", type=float)
    g.add_argument("--gradient-space", choices=["shape", "canvas"])

    g = ap.add_argument_group("extrusion")
    g.add_argument("--extrusion-depth", type=float)
    g.add_argument("--extrusion-angle", type=float)
    g.add_argument("--extrusion-color",
                   help="hex color, 'auto' (bottom gradient stop) or 'gradient' "
                        "(each swept pixel keeps the gradient color of its source)")
    g.add_argument("--no-extrusion", action="store_true")

    g = ap.add_argument_group("shading")
    g.add_argument("--no-shading", action="store_true")
    g.add_argument("--extrusion-darken", type=float,
                   help="V drop applied to the whole extrusion, 0.15 by default")
    g.add_argument("--shading-strength", type=float)
    g.add_argument("--shading-saturation", type=float,
                   help="S gain that follows the darkening")
    g.add_argument("--smoothness", type=float)
    g.add_argument("--highlight-size", type=float)
    g.add_argument("--highlight-color")
    g.add_argument("--highlight-strength", type=float)
    return ap


def params_from_args(args) -> RenderParams:
    try:
        p = load_preset(args.preset, args.presets_file)
    except Exception:
        p = default_params()

    if args.params:
        with open(args.params, "r", encoding="utf-8") as fh:
            p = RenderParams.from_dict({**p.to_dict(), **json.load(fh)})

    simple = ["canvas_size", "padding", "supersample", "fit_mode", "logo_color",
              "stroke_width", "gradient_angle", "gradient_space", "extrusion_depth",
              "extrusion_angle", "extrusion_color", "extrusion_darken",
              "shading_strength", "shading_saturation", "smoothness",
              "highlight_size", "highlight_color", "highlight_strength"]
    changes = {k: getattr(args, k) for k in simple if getattr(args, k, None) is not None}

    stops = list(p.gradient_stops)
    if args.gradient_stops:
        stops = args.gradient_stops
    else:
        if args.gradient_top:
            stops = [(0.0, args.gradient_top)] + [s for s in stops if s[0] > 0.0]
        if args.gradient_bottom:
            stops = [s for s in stops if s[0] < 1.0] + [(1.0, args.gradient_bottom)]
    changes["gradient_stops"] = stops

    if args.fill_holes:
        changes["fill_holes"] = True
    if args.no_logo:
        changes["logo_enabled"] = False
    if args.no_extrusion:
        changes["extrusion_enabled"] = False
    if args.no_shading:
        changes["shading_enabled"] = False
    if args.no_scale_with_canvas:
        changes["scale_with_canvas"] = False
    return dataclasses.replace(p, **changes)


def expand_inputs(patterns: List[str]) -> List[str]:
    files: List[str] = []
    for pat in patterns:
        if os.path.isdir(pat):
            files.extend(sorted(glob.glob(os.path.join(pat, "*.svg"))))
        elif any(ch in pat for ch in "*?["):
            files.extend(sorted(glob.glob(pat)))
        else:
            files.append(pat)
    return files


def main(argv: Optional[List[str]] = None) -> int:
    ap = build_parser()
    args = ap.parse_args(argv)

    if args.list_presets:
        for name, data in load_presets(args.presets_file).items():
            print(f"{name}: {json.dumps(data, sort_keys=True)}")
        return 0

    files = expand_inputs(args.inputs)
    if not files:
        ap.error("no input SVG given")

    p = params_from_args(args)
    if args.dump_params:
        with open(args.dump_params, "w", encoding="utf-8") as fh:
            json.dump(p.to_dict(), fh, indent=2)

    if args.output and len(files) > 1:
        ap.error("--output takes a single input; use --outdir for batches")
    if args.outdir:
        os.makedirs(args.outdir, exist_ok=True)

    for path in files:
        stem = os.path.splitext(os.path.basename(path))[0]
        if args.output and len(files) == 1:
            dest = args.output
        else:
            outdir = args.outdir or os.path.dirname(path) or "."
            dest = os.path.join(outdir, f"{stem}{args.suffix}.png")
        t0 = time.time()
        try:
            result = render(path, p)
        except Exception as exc:
            print(f"{path}: FAILED ({exc})", file=sys.stderr)
            continue
        save_png(result.image, dest)
        for w in result.warnings:
            print(f"{path}: warning: {w}", file=sys.stderr)
        print(f"{dest}  {p.canvas_size}x{p.canvas_size}  {time.time() - t0:.2f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
