import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ColorField,
  NumberField,
  Row,
  SelectField,
  StopsField,
  Toggle,
} from "./components/Fields";
import { ColorPicker } from "./components/ColorPicker";
import { DEFAULTS, PRESETS, type Params } from "./lib/params";
import { Renderer, downloadBlob, toImageData, toPngBlob } from "./lib/client";
import { makeZip, type ZipEntry } from "./lib/zip";

type Source = { name: string; text: string; shapeRef?: number };
type Status = { kind: "idle" | "busy" | "error"; text: string };

const EXAMPLES = ["bolt.svg", "facets.svg", "facets-solid.svg", "loop.svg", "donut.svg", "star.svg", "glyph.svg"];
const PREVIEW_SIZES = [480, 640, 800, 1024];

const stripExt = (name: string) => name.replace(/\.(svgz?|png)$/i, "");

/** Wrap a PNG in an SVG at its native pixel size, so the rest of the pipeline
 *  (alpha mask, shape ref, batch export) handles it like any other SVG. The
 *  silhouette comes from the PNG alpha channel. */
async function pngToSvg(file: File): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  const bitmap = await createImageBitmap(file);
  const { width, height } = bitmap;
  bitmap.close();
  if (!width || !height) throw new Error("empty PNG");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<image width="${width}" height="${height}" href="${dataUrl}" xlink:href="${dataUrl}"/></svg>`
  );
}

export default function App() {
  const [params, setParams] = useState<Params>(DEFAULTS);
  const [sources, setSources] = useState<Source[]>([]);
  const [active, setActive] = useState(0);
  const [previewSize, setPreviewSize] = useState(640);
  const [background, setBackground] = useState<"checker" | "dark" | "light">("checker");
  const [status, setStatus] = useState<Status>({ kind: "idle", text: "loading" });
  const [meta, setMeta] = useState("");
  const [presetName, setPresetName] = useState(PRESETS[0].name);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const requestRef = useRef(0);

  if (rendererRef.current === null) rendererRef.current = new Renderer();

  const set = useCallback(<K extends keyof Params>(key: K, value: Params[K]) => {
    setParams((prev) => ({ ...prev, [key]: value }));
  }, []);

  // load the bundled examples once
  useEffect(() => {
    let cancelled = false;
    Promise.all(
      EXAMPLES.map(async (name) => ({
        name,
        text: await (await fetch(`${import.meta.env.BASE_URL}examples/${name}`)).text(),
      }))
    )
      .then((loaded) => {
        if (!cancelled) setSources(loaded);
      })
      .catch(() => setStatus({ kind: "error", text: "could not load the examples" }));
    return () => {
      cancelled = true;
    };
  }, []);

  const source = sources[active];
  const shapeText =
    source && source.shapeRef !== undefined ? sources[source.shapeRef]?.text : undefined;

  const setShapeRef = useCallback(
    (index: number) => {
      setSources((prev) =>
        prev.map((s, i) =>
          i === active ? { ...s, shapeRef: index < 0 ? undefined : index } : s
        )
      );
    },
    [active]
  );

  // live preview, debounced
  useEffect(() => {
    if (!source) return;
    const handle = window.setTimeout(async () => {
      const id = ++requestRef.current;
      setStatus({ kind: "busy", text: "rendering" });
      try {
        const out = await rendererRef.current!.render(
          source.text,
          { ...params, canvasSize: previewSize },
          shapeText
        );
        if (id !== requestRef.current) return;
        const canvas = canvasRef.current;
        if (canvas) {
          canvas.width = out.size;
          canvas.height = out.size;
          canvas.getContext("2d")!.putImageData(toImageData(out), 0, 0);
        }
        setMeta(
          `${out.size} px preview, ${out.ms} ms` +
            (out.warnings.length ? ` | ${out.warnings.join("; ")}` : "")
        );
        setStatus({ kind: "idle", text: "ready" });
      } catch (err) {
        if (id !== requestRef.current) return;
        setStatus({ kind: "error", text: err instanceof Error ? err.message : String(err) });
      }
    }, 100);
    return () => window.clearTimeout(handle);
  }, [source, shapeText, params, previewSize]);

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const incoming: Source[] = [];
    for (const file of Array.from(files)) {
      if (/\.svgz?$/i.test(file.name) || file.type === "image/svg+xml") {
        incoming.push({ name: file.name, text: await file.text() });
      } else if (/\.png$/i.test(file.name) || file.type === "image/png") {
        try {
          incoming.push({ name: file.name, text: await pngToSvg(file) });
        } catch {
          setStatus({ kind: "error", text: `could not read ${file.name}` });
        }
      }
    }
    if (!incoming.length) {
      setStatus({ kind: "error", text: "no SVG or PNG file in that drop" });
      return;
    }
    setSources((prev) => {
      const next = [...prev, ...incoming];
      setActive(next.length - incoming.length);
      return next;
    });
  }, []);

  const exportPng = useCallback(async () => {
    if (!source) return;
    setStatus({ kind: "busy", text: `exporting ${params.canvasSize} px` });
    try {
      const out = await rendererRef.current!.render(source.text, params, shapeText);
      downloadBlob(await toPngBlob(out), stripExt(source.name) + "_extruded.png");
      setStatus({ kind: "idle", text: `exported in ${out.ms} ms` });
    } catch (err) {
      setStatus({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    }
  }, [source, shapeText, params]);

  const exportAll = useCallback(async () => {
    if (!sources.length) return;
    const entries: ZipEntry[] = [];
    // a file that only serves as another file's silhouette is not a deliverable
    const referenced = new Set(sources.map((s) => s.shapeRef).filter((i) => i !== undefined));
    const queue = sources.filter((_, i) => !referenced.has(i));
    try {
      for (let i = 0; i < queue.length; i++) {
        setStatus({ kind: "busy", text: `batch ${i + 1} of ${queue.length}` });
        const ref = queue[i].shapeRef !== undefined ? sources[queue[i].shapeRef!]?.text : undefined;
        const out = await rendererRef.current!.render(queue[i].text, params, ref);
        const blob = await toPngBlob(out);
        entries.push({
          name: stripExt(queue[i].name) + "_extruded.png",
          data: new Uint8Array(await blob.arrayBuffer()),
        });
      }
      downloadBlob(makeZip(entries), "svg-extrude.zip");
      setStatus({ kind: "idle", text: `${entries.length} icons exported` });
    } catch (err) {
      setStatus({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    }
  }, [sources, params]);

  const savePreset = useCallback(() => {
    const blob = new Blob([JSON.stringify({ name: "Custom", ...params }, null, 2)], {
      type: "application/json",
    });
    downloadBlob(blob, "preset.json");
  }, [params]);

  const loadPreset = useCallback(async (file: File) => {
    try {
      const data = JSON.parse(await file.text());
      delete data.name;
      setParams((prev) => ({ ...prev, ...data }));
    } catch {
      setStatus({ kind: "error", text: "that preset file could not be read" });
    }
  }, []);

  const extrusionColorMode = useMemo(() => {
    const v = params.extrusionColor.toLowerCase();
    return v === "auto" || v === "gradient" ? v : "custom";
  }, [params.extrusionColor]);

  return (
    <div
      className="app"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        void addFiles(e.dataTransfer.files);
      }}
    >
      <aside className="panel">
        <header>
          <h1>SVG Extrude</h1>
          <span className={`status ${status.kind}`}>{status.text}</span>
        </header>

        <section>
          <h2>Source</h2>
          <Row>
            <label className="file-btn">
              <input
                type="file"
                accept=".svg,image/svg+xml,.png,image/png"
                multiple
                hidden
                onChange={(e) => {
                  if (e.target.files) void addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              <span>Add SVG / PNG</span>
            </label>
            <select value={active} onChange={(e) => setActive(Number(e.target.value))}>
              {sources.map((s, i) => (
                <option key={`${s.name}-${i}`} value={i}>
                  {s.name}
                </option>
              ))}
            </select>
          </Row>
          <Row label="Shape ref">
            <select
              value={source?.shapeRef ?? -1}
              title="file whose silhouette drives the outline and the extrusion"
              onChange={(e) => setShapeRef(Number(e.target.value))}
            >
              <option value={-1}>same as logo</option>
              {sources.map((s, i) =>
                i === active ? null : (
                  <option key={`ref-${s.name}-${i}`} value={i}>
                    {s.name}
                  </option>
                )
              )}
            </select>
          </Row>
          <Row label="Preset">
            <select value={presetName} onChange={(e) => setPresetName(e.target.value)}>
              {PRESETS.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
            <button
              className="small"
              onClick={() => {
                const preset = PRESETS.find((p) => p.name === presetName);
                if (preset) setParams({ ...DEFAULTS, ...preset.params });
              }}
            >
              Apply
            </button>
          </Row>
        </section>

        <section>
          <h2>Canvas</h2>
          <NumberField label="Canvas size" min={256} max={6000} step={8} integer
            value={params.canvasSize} onChange={(v) => set("canvasSize", v)} />
          <NumberField label="Padding" min={0} max={900} step={1}
            value={params.padding} onChange={(v) => set("padding", v)} />
          <SelectField label="Supersample" value={params.supersample}
            options={[1, 2, 3, 4].map((v) => ({ value: v, label: String(v) }))}
            onChange={(v) => set("supersample", v)} />
          <SelectField label="Fit mode" value={params.fitMode}
            options={[
              { value: "composite" as const, label: "composite" },
              { value: "front" as const, label: "front face" },
            ]}
            onChange={(v) => set("fitMode", v)} />
        </section>

        <section>
          <h2>Logo</h2>
          <Toggle label="Show logo" value={params.logoEnabled} onChange={(v) => set("logoEnabled", v)} />
          <ColorField label="Logo color" value={params.logoColor} onChange={(v) => set("logoColor", v)} />
        </section>

        <section>
          <h2>Border</h2>
          <NumberField label="Stroke width" min={0} max={900} step={1}
            value={params.strokeWidth} onChange={(v) => set("strokeWidth", v)} />
          <Toggle label="Fill holes" value={params.fillHoles}
            onChange={(v) => set("fillHoles", v)} />
          <SelectField label="Gradient" value={params.gradientMode}
            options={[
              { value: "linear" as const, label: "linear ramp" },
              { value: "points" as const, label: "anchor points" },
            ]}
            onChange={(v) => set("gradientMode", v)} />
          <StopsField
            stops={params.gradientStops}
            mode={params.gradientMode}
            sharpness={params.gradientSharpness}
            onChange={(v) => set("gradientStops", v)}
          />
          {params.gradientMode === "linear" ? (
            <NumberField label="Gradient angle" min={0} max={360} step={1}
              value={params.gradientAngle} onChange={(v) => set("gradientAngle", v)} />
          ) : (
            <NumberField label="Blend" min={0.5} max={4} step={0.1}
              value={params.gradientSharpness}
              onChange={(v) => set("gradientSharpness", v)} />
          )}
          <SelectField label="Gradient span" value={params.gradientSpace}
            options={[
              { value: "shape" as const, label: "shape" },
              { value: "canvas" as const, label: "canvas" },
            ]}
            onChange={(v) => set("gradientSpace", v)} />
        </section>

        <section>
          <h2>Extrusion</h2>
          <Toggle label="Extrusion" value={params.extrusionEnabled}
            onChange={(v) => set("extrusionEnabled", v)} />
          <NumberField label="Depth" min={0} max={1200} step={1}
            value={params.extrusionDepth} onChange={(v) => set("extrusionDepth", v)} />
          <NumberField label="Angle" min={0} max={360} step={1}
            value={params.extrusionAngle} onChange={(v) => set("extrusionAngle", v)} />
          <Row label="Color">
            <select
              value={extrusionColorMode}
              onChange={(e) => {
                const mode = e.target.value;
                set("extrusionColor", mode === "custom" ? "#2A7A43" : mode);
              }}
            >
              <option value="auto">auto (bottom stop)</option>
              <option value="gradient">inherit gradient</option>
              <option value="custom">custom color</option>
            </select>
            <ColorPicker
              disabled={extrusionColorMode !== "custom"}
              value={extrusionColorMode === "custom" ? params.extrusionColor : "#2A7A43"}
              onChange={(v) => set("extrusionColor", v)}
            />
          </Row>
        </section>

        <section>
          <h2>Shading</h2>
          <Toggle label="Shading" value={params.shadingEnabled}
            onChange={(v) => set("shadingEnabled", v)} />
          <NumberField label="Darken" min={0} max={1} step={0.01}
            value={params.extrusionDarken} onChange={(v) => set("extrusionDarken", v)} />
          <NumberField label="Depth ramp" min={0} max={1} step={0.01}
            value={params.shadingStrength} onChange={(v) => set("shadingStrength", v)} />
          <NumberField label="Saturation" min={0} max={1} step={0.01}
            value={params.shadingSaturation} onChange={(v) => set("shadingSaturation", v)} />
          <NumberField label="Smoothness" min={0} max={100} step={1}
            value={params.smoothness} onChange={(v) => set("smoothness", v)} />
          <NumberField label="Edge size" min={0} max={1} step={0.01}
            value={params.highlightSize} onChange={(v) => set("highlightSize", v)} />
          <ColorField label="Edge color" value={params.highlightColor}
            onChange={(v) => set("highlightColor", v)} />
          <NumberField label="Edge amount" min={0} max={1} step={0.01}
            value={params.highlightStrength} onChange={(v) => set("highlightStrength", v)} />
        </section>

        <section>
          <h2>Output</h2>
          <SelectField label="Preview size" value={previewSize}
            options={PREVIEW_SIZES.map((v) => ({ value: v, label: String(v) }))}
            onChange={setPreviewSize} />
          <div className="row buttons">
            <button className="primary" onClick={() => void exportPng()}>
              Export PNG
            </button>
            <button className="small" onClick={() => void exportAll()}>
              Export all as ZIP
            </button>
          </div>
          <div className="row buttons">
            <button className="small" onClick={savePreset}>Save preset</button>
            <label className="file-btn small">
              <input
                type="file"
                accept=".json"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void loadPreset(file);
                  e.target.value = "";
                }}
              />
              <span>Load preset</span>
            </label>
            <button className="small" onClick={() => setParams(DEFAULTS)}>Reset</button>
          </div>
        </section>
      </aside>

      <main className="stage">
        <div className="stage-bar">
          <div className="bg-toggle">
            {(["checker", "dark", "light"] as const).map((b) => (
              <button key={b} className={background === b ? "active" : ""} onClick={() => setBackground(b)}>
                {b}
              </button>
            ))}
          </div>
          <span className="meta">{meta}</span>
        </div>
        <div className={`viewport ${background}`}>
          <canvas ref={canvasRef} />
        </div>
      </main>
    </div>
  );
}
