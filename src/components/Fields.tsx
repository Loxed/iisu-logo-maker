import type { ReactNode } from "react";
import type { GradientStop } from "../lib/params";
import { ColorPicker, HexInput, hexToRgb, rgbToHex } from "./ColorPicker";
import { GradientPad } from "./GradientPad";

export { HexInput, normalizeHex } from "./ColorPicker";

export function Row({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="row">
      {label !== undefined && <label>{label}</label>}
      {children}
    </div>
  );
}

export function NumberField(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  integer?: boolean;
  onChange: (v: number) => void;
}) {
  const clamp = (v: number) => {
    let x = Math.min(props.max, Math.max(props.min, v));
    if (props.integer) x = Math.round(x);
    return x;
  };
  return (
    <Row label={props.label}>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(clamp(Number(e.target.value)))}
      />
      <input
        type="number"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) props.onChange(clamp(v));
        }}
      />
    </Row>
  );
}

export function ColorField(props: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <Row label={props.label}>
      <ColorPicker value={props.value} onChange={props.onChange} />
      <HexInput value={props.value} onChange={props.onChange} />
    </Row>
  );
}

export function Toggle(props: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <Row label={props.label}>
      <input
        type="checkbox"
        checked={props.value}
        onChange={(e) => props.onChange(e.target.checked)}
      />
    </Row>
  );
}

export function SelectField<T extends string | number>(props: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <Row label={props.label}>
      <select
        value={String(props.value)}
        onChange={(e) => {
          const raw = e.target.value;
          const found = props.options.find((o) => String(o.value) === raw);
          if (found) props.onChange(found.value);
        }}
      >
        {props.options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
    </Row>
  );
}

/** Color of the ramp at t, with the same linear interpolation as the renderer. */
function sampleGradient(stops: GradientStop[], t: number): string {
  const sorted = [...stops].sort((a, b) => a.pos - b.pos);
  if (!sorted.length) return "#FFFFFF";
  if (t <= sorted[0].pos) return sorted[0].color;
  const last = sorted[sorted.length - 1];
  if (t >= last.pos) return last.color;
  let i = 0;
  while (i < sorted.length - 2 && t > sorted[i + 1].pos) i++;
  const a = sorted[i];
  const b = sorted[i + 1];
  const span = b.pos - a.pos;
  const f = span <= 1e-6 ? 0 : (t - a.pos) / span;
  const ca = hexToRgb(a.color);
  const cb = hexToRgb(b.color);
  return rgbToHex(
    ca[0] + (cb[0] - ca[0]) * f,
    ca[1] + (cb[1] - ca[1]) * f,
    ca[2] + (cb[2] - ca[2]) * f
  );
}

export function StopsField(props: {
  stops: GradientStop[];
  mode: "linear" | "points";
  sharpness: number;
  onChange: (stops: GradientStop[]) => void;
}) {
  const update = (i: number, patch: Partial<GradientStop>) => {
    props.onChange(props.stops.map((s, j) => (i === j ? { ...s, ...patch } : s)));
  };
  // resampling the current ramp keeps the look while changing how many
  // handles there are to edit
  const setCount = (n: number) => {
    props.onChange(
      Array.from({ length: n }, (_, i) => {
        const pos = n === 1 ? 0 : i / (n - 1);
        return { pos, color: sampleGradient(props.stops, pos) };
      })
    );
  };
  const sorted = [...props.stops].sort((a, b) => a.pos - b.pos);
  const css = `linear-gradient(to right, ${sorted
    .map((s) => `${s.color} ${Math.round(s.pos * 100)}%`)
    .join(", ")})`;

  return (
    <div className="stops">
      <Row label="Colors">
        <div className="seg" role="group" aria-label="number of gradient colors">
          {[2, 3, 4, 5].map((n) => (
            <button
              key={n}
              className={props.stops.length === n ? "active" : ""}
              onClick={() => setCount(n)}
              title={`${n} evenly spaced colors`}
            >
              {n}
            </button>
          ))}
        </div>
        <button
          className="small"
          title="add one stop between the existing ones"
          onClick={() => {
            const first = props.stops[0]?.pos ?? 0;
            const last = props.stops[props.stops.length - 1]?.pos ?? 1;
            const mid = (first + last) / 2;
            const next = [...props.stops, { pos: mid, color: sampleGradient(props.stops, mid) }];
            next.sort((a, b) => a.pos - b.pos);
            props.onChange(next);
          }}
        >
          +
        </button>
      </Row>
      {props.mode === "points" ? (
        <GradientPad stops={props.stops} sharpness={props.sharpness} onChange={props.onChange} />
      ) : (
        <div className="gradient-bar" style={{ background: css }} />
      )}
      {props.stops.map((s, i) => (
        <div className="stop" key={i}>
          {props.mode === "linear" ? (
            <input
              className="pos"
              type="number"
              min={0}
              max={1}
              step={0.01}
              value={s.pos}
              title="position along the gradient, 0 to 1"
              onChange={(e) =>
                update(i, { pos: Math.min(1, Math.max(0, Number(e.target.value))) })
              }
            />
          ) : (
            <span className="pos index">{i + 1}</span>
          )}
          <ColorPicker value={s.color} onChange={(v) => update(i, { color: v })} />
          <HexInput value={s.color} onChange={(v) => update(i, { color: v })} />
          <button
            className="remove"
            title="remove this stop"
            disabled={props.stops.length <= 2}
            onClick={() => props.onChange(props.stops.filter((_, j) => j !== i))}
          >
            x
          </button>
        </div>
      ))}
    </div>
  );
}
