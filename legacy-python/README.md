# svgextrude

Thick outline, vertical gradient and parallel 3D extrusion for SVG icons, in the
style of ibisPaint X "Extrude Parallel". Input is an SVG plus parameters, output
is a transparent PNG, 3000 x 3000 by default.

The extrusion is a geometric sweep of the expanded silhouette: the union of the
shape translated along a direction over a distance. It is not a blurred drop
shadow, and it has hard edges at every angle.

```
layers, top to bottom
  3. original SVG silhouette, flat color (white by default)
  2. front face: silhouette expanded by stroke_width, vertical gradient
  1. extrusion: front face swept over extrusion_depth at extrusion_angle, shaded
```

## Install

```bash
pip install -r requirements.txt
```

On Windows, follow GETTING_STARTED.md instead, which covers PowerShell, the
virtual environment and the rasterizer choice step by step.

Any one of these rasterizers is enough, and they are tried in this order:

| backend | install | note |
| --- | --- | --- |
| cairosvg | `pip install cairosvg` plus cairo on the system (`brew install cairo`, `sudo apt install libcairo2`) | fastest, read straight from the cairo surface |
| resvg-py | `pip install resvg-py` | self contained wheel, nothing else to install, the default on Windows |
| resvg, rsvg-convert or inkscape | any of them on PATH | command line fallback |

The first one that works is remembered for the rest of the session. To see which
one is active:

```bash
python3 -c "import svgextrude.svgload as s; print(s.active_backend())"
```

## Local UI

```bash
python3 -m svgextrude.server        # opens http://127.0.0.1:8765
./run.sh                            # same thing
```

Drop an SVG on the preview area or use Select SVG. Every control re-renders a
small preview (640 px by default, about 100 ms). Export PNG renders at the full
`canvas_size`. The four SVGs in `examples/` are preloaded so the UI is usable
before you upload anything.

Because every length scales with `canvas_size`, the preview is an exact
miniature of the export. What you see at 640 px is what you get at 3000 px.

## CLI

```bash
# one icon with the default preset
python3 -m svgextrude.cli icon.svg -o icon.png

# a whole folder, smaller canvas
python3 -m svgextrude.cli icons/ --outdir build/ --canvas-size 1024

# custom look
python3 -m svgextrude.cli icon.svg -o icon.png \
    --gradient-stops "0:#FFD166,0.5:#F4845F,1:#D6455D" \
    --extrusion-angle 115 --extrusion-depth 220 --stroke-width 260

# reuse a preset saved from the UI
python3 -m svgextrude.cli icons/*.svg --outdir build/ --params my_preset.json

python3 -m svgextrude.cli --list-presets
python3 -m svgextrude.cli --help
```

`--dump-params out.json` writes the resolved parameter set, which is the same
JSON the UI loads and saves.

## Python API

```python
import dataclasses
from svgextrude import default_params, render, save_png

params = dataclasses.replace(default_params(), canvas_size=2048, extrusion_angle=120)
result = render("icon.svg", params)      # result.image is a (H, W, 4) uint8 array
save_png(result.image, "icon.png")
```

`render()` accepts a path, raw SVG bytes or an SVG string. It has no dependency
on the UI, so it can be dropped into a batch pipeline as is. Rasterized
silhouettes are cached by content hash, so re-rendering the same icon with new
parameters skips the SVG rasterization.

## Parameters

| name | default | meaning |
| --- | --- | --- |
| `canvas_size` | 3000 | output width and height in pixels |
| `padding` | 200 | free margin kept around the whole composition |
| `supersample` | 2 | internal oversampling factor, 1 to 4 |
| `fit_mode` | `composite` | `composite` centers artwork plus extrusion, `front` centers the front face and lets the extrusion sit off center |
| `scale_with_canvas` | true | when true, `stroke_width`, `extrusion_depth` and `padding` are multiplied by `canvas_size / reference_size` |
| `reference_size` | 3000 | canvas size the lengths above are quoted at |
| `logo_color` | `#FFFFFF` | fill of the original SVG silhouette |
| `logo_enabled` | true | draw the silhouette on top of the front face |
| `stroke_width` | 210 | outside stroke in pixels, round joins, exact Euclidean expansion |
| `fill_holes` | false | close the pockets of the front face that the canvas border cannot reach, so a looped icon reads as one solid shape |
| `gradient_stops` | `[[0, "#2FFF74"], [1, "#369052"]]` | list of `[position, hex]`, position 0 to 1, any number of stops |
| `gradient_angle` | 90 | 90 runs the gradient top to bottom, 0 runs it left to right |
| `gradient_space` | `shape` | `shape` spans the front face bounding box, `canvas` spans the full canvas |
| `extrusion_enabled` | true | draw the swept body behind the front face |
| `extrusion_depth` | 150 | sweep distance in pixels |
| `extrusion_angle` | 90 | sweep direction in degrees, 90 is straight down, 0 is right, 180 is left |
| `extrusion_color` | `auto` | `auto` takes the last gradient stop, `gradient` gives every swept pixel the gradient color of the front face pixel it came from, otherwise a hex color |
| `shading_enabled` | true | apply the darkening, the depth ramp and the edge accent |
| `extrusion_darken` | 0.15 | HSV value drop applied to the whole extrusion, so the side face separates from the front face even at the bottom of the icon where both would otherwise share a color |
| `shading_strength` | 0.20 | extra value drop at the far end of the sweep, on top of `extrusion_darken` |
| `shading_saturation` | 0.10 | HSV saturation gain that follows the darkening, so the dark end stays a shade of the same color instead of turning gray |
| `smoothness` | 50 | 0 gives a linear depth ramp, 100 gives a fully eased S curve |
| `highlight_size` | 0.10 | fraction of the depth that receives the edge accent, 0.10 means the first 10 percent |
| `highlight_color` | `#FFFFFF` | color blended into the extrusion near the front face, `#000000` turns the accent into a dark crease |
| `highlight_strength` | 0.0 | blend amount at the fold, 0 leaves the fold clean |

`extrusion_color = "gradient"` reproduces what a pixel level extrude does: the
sweep carries the source color, so the side face repeats the front face gradient
instead of a single tone. The depth ramp and the highlight apply on top of it in
both modes.

With the defaults, the extrusion color runs from V x 0.85 at the fold to V x 0.68
at the far end, with S rising by up to 10 percent along the way. The front face
keeps its gradient, so the fold stays readable at every point of the outline.

The edge accent falls off as `strength * (1 - t / highlight_size) ** p`, with `t`
the normalized sweep depth and `p` running from 1 to 3 as `smoothness` goes 0 to
100. The slope is steepest at the fold, so it reads as a sheen instead of a
stripe. `highlight_strength = 0` disables it, which is the default.
`highlight_color = "#000000"` with a strength around 0.2 draws a dark crease
along the fold instead of a lit edge, which is the `Dark fold` preset.

## Presets

`svgextrude/presets.json` holds the named presets:

- `Green Extruded`, the default
- `Green Extruded (lit edge)`, same with `highlight_strength` at 0.15
- `Green Extruded (inherit gradient)`, side face repeating the front gradient
- `Dark fold`, black edge accent instead of a lit one

Save preset in the UI writes the current values as JSON, and `--params file.json`
feeds them back to the CLI.

## How it works

1. `svgload.load_logo_mask` rasterizes the SVG twice. The first pass is a 512 px
   probe used only to measure the ink bounding box, since the viewBox often
   carries empty margins. The second pass renders at the resolution that makes
   that bounding box the size the layout asked for, then crops to it. Only the
   alpha channel is kept, so holes in the artwork stay holes.
2. `render.compute_layout` solves for the logo size that keeps
   `logo + 2 * stroke_width + extrusion offset` inside `canvas_size - 2 * padding`,
   then centers that whole box. The extrusion cannot be clipped by construction.
3. `ops.dilate_round` builds the front face as an exact Euclidean distance field
   thresholded at `stroke_width`, which gives round outer corners and a one
   pixel anti-aliased edge. It does not use a square or diamond kernel.
4. `ops.sweep_mask` shears the image so the sweep direction becomes an axis, runs
   a backward running maximum over `depth` samples, then shears back. The running
   maximum uses sparse table doubling, so it costs `log2(depth)` array passes
   instead of `depth` shifted copies, and the swept body is solid with no banding
   whatever the depth. At multiples of 90 degrees the shear is the identity and
   the operation is lossless.
5. The same scan records, for every pixel, how far back along the sweep the front
   face is. That map drives the shading ramp and the highlight through a 256
   entry color lookup table.
6. Everything is composited premultiplied at `canvas_size * supersample`, then
   box filtered down. The depth map is downsampled with alpha weighting, so edge
   pixels of the extrusion carry the right shade instead of a fringe.

## Performance

Measured on two cores, `supersample = 2`:

| canvas | cold | warm cache |
| --- | --- | --- |
| 640 | 0.3 s | 0.10 s |
| 1024 | 0.5 s | 0.25 s |
| 3000 | 3.5 s | 2.8 s |

Peak memory at 3000 px is roughly 700 MB. Drop `supersample` to 1 to halve both
figures, at a small cost in edge quality on diagonal sweeps.

## Limits

- An SVG that paints a full background rectangle produces a square silhouette,
  because the mask is the union of everything the file paints. Remove the
  background rect first.
- Text elements are rasterized with the fonts available on the machine. Convert
  text to paths for reproducible output.
- Sweep angles that are not multiples of 90 degrees go through one shear and one
  inverse shear, each with bilinear interpolation. At `supersample = 2` the edge
  softening is below half a pixel in the final image.
