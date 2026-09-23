# svg-extrude

Thick outline, vertical gradient and parallel 3D extrusion for SVG icons, in the
style of ibisPaint X "Extrude Parallel". Runs entirely in the browser: the SVG
never leaves the machine, there is no backend, and the built site is static
files that GitHub Pages or Cloudflare Pages serve as they are.

Input is an SVG (or a PNG with transparency) plus parameters, output is a transparent PNG, 3000 x 3000 by
default.

The extrusion is a geometric sweep of the expanded silhouette: the union of the
shape translated along a direction over a distance. It is not a blurred drop
shadow, and it keeps hard edges at every angle.

```
layers, top to bottom
  3. original SVG silhouette, flat color (white by default)
  2. front face: silhouette expanded by strokeWidth, vertical gradient
  1. extrusion: front face swept over extrusionDepth at extrusionAngle, shaded
```

Windows and PowerShell instructions are in GETTING_STARTED.md.

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/
npm run preview    # serve dist/ to check it
```

## What it does

1. **Silhouette.** The SVG is rasterized by the browser twice: once small to
   measure the real ink box, since icon files often carry empty margins, then
   again at the resolution that makes that box the size the layout asked for.
   Only the alpha channel is kept, so holes in the artwork stay holes.
2. **Framing.** The layout solves for the logo size that keeps
   `logo + 2 * strokeWidth + extrusion offset` inside `canvasSize - 2 * padding`,
   then centers that whole box. The extrusion cannot be clipped by construction,
   at any angle.
3. **Outline.** The front face is an exact euclidean distance field thresholded
   at `strokeWidth`, which gives round outer corners and a one pixel anti
   aliased edge. A square or diamond structuring element cannot do that.
4. **Sweep.** The image is sheared so the sweep direction becomes an axis, then
   a backward running maximum runs along it. The running maximum uses sparse
   table doubling, so it costs log2(depth) passes instead of depth shifted
   copies, and the swept body is solid with no banding whatever the depth. At
   multiples of 90 degrees the shear is the identity and the operation is
   lossless.
5. **Shading.** The same scan records how far back along the sweep the front
   face is for every pixel. That depth drives an HSV ramp: V drops, S rises
   slightly, and an optional accent sits at the fold.
6. **Output.** Everything is composited premultiplied at
   `canvasSize * supersample`, then box filtered down. The depth map is
   downsampled with alpha weighting, so edge pixels of the extrusion carry the
   right shade instead of a fringe.

Steps 2 to 6 run in a Web Worker, so the interface stays responsive during a
3000 px export.

## Shape reference

Icons are often published as a set of separate facets with thin gaps between
them, the Google Play mark being the usual example. Growing an outline around
that geometry follows every gap, so the border cuts into the artwork and the
result looks broken.

Shape ref, in the Source panel, points the active file at another loaded file.
The outline and the extrusion then come from that file's silhouette, while the
white artwork on top still comes from the active one. Load the solid version of
the mark as the reference and the split version as the logo.

Both files are rasterized into the same pixel frame, fitted with xMidYMid meet
and cropped with the same rectangle, so two exports of one artwork stay in
register without any manual alignment. Framing is always driven by the shape.
A file used only as a reference is skipped by the batch export.

## Gradient modes

**linear** runs one ramp across the front face along `gradientAngle`, with any
number of stops.

**anchor points** drops each color at its own spot in the box and fills
everything between them. Green at top center, blue at middle left, yellow at
middle right, red at bottom center gives the four way blend of a facetted mark,
which no linear ramp can do. The field is inverse distance weighted: a pixel
takes the mix of every color by 1 / distance to its anchor, raised to `Blend`.
Blend 1 spreads each color broadly, Blend 3 or 4 keeps it close to its anchor
and the boundaries read almost as facets.

The pad under the mode selector is the editor and the preview at once: it draws
the same field the renderer uses, and the dots are dragged to place each color.
A dot dropped near one of the nine usual spots (corners, edge centers, center)
snaps to it, so top center really is top center.

The field is baked into a 160 by 160 grid and sampled bilinearly per pixel,
since it is smooth. Solving it per pixel over nine million pixels would cost
seconds for a result nobody could tell apart.

The extrusion follows in `gradient` mode: a swept pixel samples the field at the
point it came from, so the side face carries the color of the region above it.

## Parameters

| name | default | meaning |
| --- | --- | --- |
| `canvasSize` | 3000 | output width and height in pixels |
| `padding` | 200 | free margin kept around the whole composition |
| `supersample` | 2 | internal oversampling factor, 1 to 4 |
| `fitMode` | `composite` | `composite` centers artwork plus extrusion, `front` centers the front face and lets the extrusion sit off center |
| `logoColor` | `#FFFFFF` | fill of the original SVG silhouette |
| `logoEnabled` | true | draw the silhouette on top of the front face |
| `strokeWidth` | 210 | outside stroke in pixels, round joins |
| `fillHoles` | true | close the pockets of the front face that the canvas border cannot reach, so an infinity loop or a letter O reads as one solid shape instead of showing the sweep through its holes |
| `gradientStops` | `0 #2FFF74`, `1 #369052` | any number of stops, position 0 to 1. The 2 3 4 5 buttons resample the current ramp to that many evenly spaced colors, and `+` inserts one more |
| `gradientMode` | `linear` | `linear` for one ramp, `points` for color anchors placed in the box |
| `gradientAngle` | 90 | linear mode: 90 runs the gradient top to bottom, 0 left to right |
| `gradientSharpness` | 1.6 | point mode: 1 blends broadly, 4 keeps each color close to its anchor |
| `gradientSpace` | `shape` | `shape` spans the front face box, `canvas` spans the canvas |
| `extrusionEnabled` | true | draw the swept body behind the front face |
| `extrusionDepth` | 150 | sweep distance in pixels |
| `extrusionAngle` | 90 | 90 is straight down, 0 is right, 180 is left |
| `extrusionColor` | `gradient` | `auto` takes the last gradient stop, `gradient` gives every swept pixel the gradient color of the front face pixel it came from, otherwise a hex color |
| `shadingEnabled` | true | apply the darkening, the depth ramp and the edge accent |
| `extrusionDarken` | 0.15 | HSV value drop on the whole extrusion, so the side face separates from the front face even at the bottom of the icon where both would otherwise share a color |
| `shadingStrength` | 0.20 | extra value drop at the far end of the sweep |
| `shadingSaturation` | 0.10 | saturation gain that follows the darkening, so the dark end stays a shade of the same color instead of turning gray |
| `smoothness` | 50 | 0 gives a linear depth ramp, 100 a fully eased S curve |
| `highlightSize` | 0.10 | fraction of the depth that receives the edge accent |
| `highlightColor` | `#FFFFFF` | accent color, `#000000` turns it into a dark crease |
| `highlightStrength` | 0.0 | accent amount at the fold, 0 leaves the fold clean |

Every length is quoted at the reference canvas of 3000 px and scaled by
`canvasSize / 3000`, so the 640 px preview is an exact miniature of the export.

With the defaults the extrusion runs from V x 0.85 at the fold to V x 0.68 at
the far end. The edge accent falls off as
`strength * (1 - t / highlightSize) ** p`, with `p` from 1 to 3 as `smoothness`
goes 0 to 100: steepest at the fold, so it reads as a sheen instead of a stripe.

## Presets

Green Extruded (default), Green Extruded (lit edge), Green Extruded (inherit
gradient), Dark fold, Sunset, Four corners, Blue Depth. They live in `src/lib/params.ts`.
Save preset in the interface writes the current values as JSON and Load preset
reads them back.

## Project layout

```
src/lib/params.ts   parameter set, presets, scaling, layout solver
src/lib/ops.ts      distance transform, sweep, resampling, gradients, shading
src/lib/render.ts   the pipeline, mask plus parameters to RGBA
src/lib/raster.ts   SVG to tight alpha mask, using the browser rasterizer
src/lib/worker.ts   worker entry, keeps the last masks
src/lib/client.ts   main thread side, rasterize then talk to the worker
src/lib/zip.ts      store only ZIP writer for the batch export
src/components/      interface widgets, including the color picker
src/App.tsx         interface
legacy-python/      the earlier Python renderer, CLI and local server
```

Nothing in `src/lib/render.ts` touches the DOM, so the renderer can be reused
in a script, a test or another interface.

## Performance

Chromium on two cores, supersample 2:

| canvas | time |
| --- | --- |
| 640 preview | 0.15 to 0.2 s |
| 1024 | 0.4 s |
| 3000 export | 3.5 to 4 s |

Batch of four icons at 1024, including PNG encoding and zipping: 3 s.

## legacy-python

The first version of this tool was a Python package with a CLI and a small
FastAPI interface. It is kept in `legacy-python/` and still works
(`pip install -r requirements.txt`, then `python -m svgextrude.cli icons/
--outdir build/`). The browser app covers the same ground, including batch
export, so the Python path is only useful to plug the renderer into an existing
Python pipeline.

Both renderers produce the same image. The browser output was checked against
the Python reference pixel by pixel: on solid pixels the mean channel
difference is 0.87 of 255, and differences only appear on the one pixel anti
aliased outline, where the two SVG rasterizers disagree slightly.
