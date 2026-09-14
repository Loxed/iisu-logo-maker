"""Quality checks for the renderer.

    python3 selftest.py

Every check prints PASS or FAIL and the script exits non zero if any failed.
"""

from __future__ import annotations

import dataclasses
import hashlib
import sys

import numpy as np

from svgextrude import default_params, render

FAILED = []


def check(name, condition, detail=""):
    print(f"{'PASS' if condition else 'FAIL'}  {name}" + (f"   {detail}" if detail else ""))
    if not condition:
        FAILED.append(name)


def bbox(image):
    ys, xs = np.nonzero(image[:, :, 3] > 0)
    return int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())


def main():
    base = default_params()

    # framing: nothing may cross the padding, at any sweep angle
    worst = None
    inside = True
    for angle in range(0, 360, 15):
        p = dataclasses.replace(base, canvas_size=900, extrusion_angle=angle,
                                extrusion_depth=400, stroke_width=260)
        x0, y0, x1, y1 = bbox(render("examples/glyph.svg", p).image)
        pad = p.scaled().padding
        margin = min(x0, y0, 900 - x1, 900 - y1) - pad
        if worst is None or margin < worst[1]:
            worst = (angle, margin)
        inside &= margin >= -1
    check("extrusion never crosses the padding", inside,
          f"tightest margin {worst[1]:.0f} px at {worst[0]} degrees")

    # the swept body is one solid run, no gaps between layers
    p = dataclasses.replace(base, canvas_size=1000, extrusion_depth=600,
                            extrusion_angle=90, stroke_width=120)
    column = render("examples/star.svg", p).image[:, 500, 3] > 128
    transitions = int((np.diff(column.astype(int)) != 0).sum())
    check("swept body has no gaps", transitions == 2, f"{transitions} alpha transitions, expected 2")

    # holes in the artwork stay holes
    img = render("examples/donut.svg", dataclasses.replace(base, canvas_size=600,
                                                           extrusion_depth=0)).image
    centre = img[300, 300]
    check("holes stay open", centre[3] == 0, f"centre alpha {centre[3]}")

    # deterministic
    a = hashlib.sha1(render("examples/bolt.svg", dataclasses.replace(base, canvas_size=500)).image.tobytes()).hexdigest()
    b = hashlib.sha1(render("examples/bolt.svg", dataclasses.replace(base, canvas_size=500)).image.tobytes()).hexdigest()
    check("output is deterministic", a == b, a[:12])

    # the preview is a faithful miniature of the export
    import cv2
    big = render("examples/bolt.svg", dataclasses.replace(base, canvas_size=1600)).image
    small = render("examples/bolt.svg", dataclasses.replace(base, canvas_size=400)).image
    down = cv2.resize(big, (400, 400), interpolation=cv2.INTER_AREA)
    solid = (down[:, :, 3] > 250) & (small[:, :, 3] > 250)
    delta = np.abs(down[:, :, :3].astype(int) - small[:, :, :3].astype(int)).max(axis=2)[solid].mean()
    check("preview matches the export", delta < 2.0, f"mean channel delta {delta:.2f}")

    # parameter extremes must not raise
    ok = True
    for kw in (dict(stroke_width=0), dict(extrusion_depth=0), dict(padding=0),
               dict(supersample=1), dict(supersample=3), dict(logo_enabled=False),
               dict(extrusion_enabled=False), dict(shading_enabled=False),
               dict(fit_mode="front"), dict(gradient_space="canvas"),
               dict(extrusion_color="gradient"), dict(extrusion_color="#FF0055"),
               dict(stroke_width=1200, extrusion_depth=1200),
               dict(gradient_stops=[(0, "#FFF"), (0.3, "#F00"), (1, "#000")])):
        try:
            render("examples/star.svg", dataclasses.replace(base, canvas_size=400, **kw))
        except Exception as exc:
            ok = False
            print(f"      {kw} raised {exc}")
    check("parameter extremes render", ok)

    print()
    if FAILED:
        print(f"{len(FAILED)} check(s) failed: " + ", ".join(FAILED))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
