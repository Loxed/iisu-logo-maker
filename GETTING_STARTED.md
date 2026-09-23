# Getting started on Windows (PowerShell)

The app is a static site. Node is needed to build it, nothing else: no Python,
no server, no API key. Once built, the contents of `dist/` are plain files that
any static host serves.

## 1. Install Node

```powershell
node --version
```

If that prints nothing or an error, install the LTS build:

```powershell
winget install OpenJS.NodeJS.LTS
```

Close and reopen PowerShell afterwards, then check `node --version` again. Any
version 20 or newer works.

## 2. Install the dependencies

```powershell
cd path\to\svg-extrude
npm install
```

If PowerShell answers `npm.ps1 cannot be loaded because running scripts is
disabled on this system`, allow local scripts for your user once:

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

`npm.cmd install` also works without changing any policy.

## 3. Run it

```powershell
npm run dev
```

Open http://localhost:5173. Edits to the source reload the page as you save.
To use another port:

```powershell
npm run dev -- --port 5180
```

## 4. Build the static site

```powershell
npm run build      # writes dist\
npm run preview    # serves dist\ at http://localhost:4173 to check it
```

`dist\` is the whole site: `index.html`, one JS bundle, one worker bundle, one
CSS file and the example SVGs. Opening `dist\index.html` from the file system
does not work, because module scripts and workers need a real http origin. Use
`npm run preview` or a host.

## 5. Put it online

### Cloudflare Pages

Connect the repository, then set:

| field | value |
| --- | --- |
| Framework preset | None |
| Build command | `npm run build` |
| Build output directory | `dist` |
| Node version | 20 or newer (`NODE_VERSION` variable) |

The site is served from the domain root, which is what the default base path
expects. Nothing else to configure.

### GitHub Pages

`.github/workflows/deploy.yml` is already in the project. Push to `main`, then
in the repository go to Settings, Pages, and set Source to GitHub Actions. The
workflow builds with `BASE_PATH=/<repository>/`, which is what makes the assets
resolve under a project sub path.

If the deployed page is blank and the console shows 404s on `/assets/...`, the
base path is wrong for that host. Build with the path the site is served from:

```powershell
$env:BASE_PATH="/svg-extrude/"; npm run build
```

### Any other static host

Upload `dist\`. Netlify, Vercel, S3, nginx, a folder served by anything: there
is no backend to run.

## 6. Use it

- Add SVG / PNG, or drop files anywhere on the page. PNGs use their alpha
  channel as the silhouette, so they need a transparent background. Several at once is fine.
- Every control re-renders a small preview, about 150 ms at 640 px.
- Export PNG writes the current icon at the full canvas size to your Downloads
  folder. Export all as ZIP does every loaded icon with the same parameters.
- Clicking a swatch opens the in page color picker: saturation and value
  square, hue bar, hex field, and a pipette to sample any pixel on the screen
  where the browser supports it (Chrome and Edge). Arrow keys nudge the
  selection, shift makes bigger steps, Escape closes. No operating system
  dialog is involved.
- Every color also takes a hex value typed or pasted into the field next to the
  swatch: `2FFF74`, `#2fff74` and the short `c44` all work, and an invalid
  value reverts on blur instead of corrupting the parameter. Each gradient stop
  has its own hex field plus its position from 0 to 1, and the bar above the
  list previews the ramp.
- Shape ref, under Source, borrows another loaded file's silhouette for the
  outline and the extrusion while keeping the current file as the white
  artwork. That is what to use for an icon published as separate facets with
  gaps between them, where growing an outline around the geometry itself would
  follow every gap.
- Gradient, under Border, switches between a linear ramp and anchor points. In
  anchor point mode each color sits at its own spot in the box and the field
  between them is filled in, which is how a four color mark is built: green at
  top center, blue at middle left, yellow at middle right, red at bottom
  center. Drag the dots on the pad, they snap to the nine usual spots. Blend
  controls how tightly each color stays around its anchor. The Four corners
  preset is that setup, ready to recolor.
- Colors, under Border, sets how many stops the gradient has, from 2 to 5. The
  current ramp is resampled, so the look is kept and only the number of handles
  changes. Each stop keeps its own position and hex field.
- Fill holes, under Border, closes the enclosed pockets of the shape. It is on
  by default, so an icon with loops reads as one solid volume. Turn it off to
  show the extrusion through its holes.
- Save preset writes the current values as JSON, Load preset reads them back.

## Troubleshooting

**`npm install` fails behind a corporate proxy.** Set the registry proxy once:
`npm config set proxy http://user:pass@host:port` and the same for
`https-proxy`.

**The 3000 px export takes a few seconds.** That is expected: a 3000 px canvas
at supersample 2 is 36 million pixels of distance field and sweep. Lower
Supersample to 1 to roughly halve the time, at a small cost on diagonal sweep
edges.

**A very large export fails in the browser.** Canvas is capped by the browser,
and a 6000 px canvas at supersample 3 needs close to a gigabyte. Keep
Supersample at 2 above 4000 px.

**An icon comes out as a filled square.** The SVG paints a background
rectangle, and the mask is the union of everything the file paints. Remove that
rect in the source file.

**Text in the SVG moves or disappears.** Text is rendered with the fonts the
browser has. Convert text to paths before importing.
