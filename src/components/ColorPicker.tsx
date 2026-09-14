import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// --------------------------------------------------------------------------
// color math
// --------------------------------------------------------------------------
export type Hsv = { h: number; s: number; v: number };

/** Accepts fff, #fff, 2FFF74, #2fff74 and 8 digit hex with the alpha dropped. */
export function normalizeHex(raw: string): string | null {
  let s = raw.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(s)) s = s.split("").map((c) => c + c).join("");
  if (/^[0-9a-fA-F]{8}$/.test(s)) s = s.slice(0, 6);
  return /^[0-9a-fA-F]{6}$/.test(s) ? "#" + s.toUpperCase() : null;
}

export function hexToRgb(hex: string): [number, number, number] {
  const s = normalizeHex(hex) ?? "#000000";
  return [
    parseInt(s.slice(1, 3), 16),
    parseInt(s.slice(3, 5), 16),
    parseInt(s.slice(5, 7), 16),
  ];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const f = (c: number) =>
    Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, "0");
  return ("#" + f(r) + f(g) + f(b)).toUpperCase();
}

export function hsvToRgb({ h, s, v }: Hsv): [number, number, number] {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const t: [number, number, number] =
    h < 60 ? [c, x, 0]
    : h < 120 ? [x, c, 0]
    : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c]
    : h < 300 ? [x, 0, c]
    : [c, 0, x];
  return [(t[0] + m) * 255, (t[1] + m) * 255, (t[2] + m) * 255];
}

export function rgbToHsv(r: number, g: number, b: number): Hsv {
  const rr = r / 255;
  const gg = g / 255;
  const bb = b / 255;
  const mx = Math.max(rr, gg, bb);
  const mn = Math.min(rr, gg, bb);
  const d = mx - mn;
  let h = 0;
  if (d > 0) {
    if (mx === rr) h = 60 * (((gg - bb) / d) % 6);
    else if (mx === gg) h = 60 * ((bb - rr) / d + 2);
    else h = 60 * ((rr - gg) / d + 4);
  }
  if (h < 0) h += 360;
  return { h, s: mx === 0 ? 0 : d / mx, v: mx };
}

export const hsvToHex = (hsv: Hsv) => rgbToHex(...hsvToRgb(hsv));
export const hexToHsv = (hex: string) => rgbToHsv(...hexToRgb(hex));

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

// recently committed colors, shared by every picker on the page
const recents: string[] = [];
function remember(hex: string) {
  const i = recents.indexOf(hex);
  if (i >= 0) recents.splice(i, 1);
  recents.unshift(hex);
  if (recents.length > 8) recents.pop();
}

// --------------------------------------------------------------------------
// hex text field
// --------------------------------------------------------------------------
/**
 * Keeps its own draft while focused: a field fed straight from the parameter
 * would reject every intermediate state, so "#2FF" could never be typed. The
 * draft is committed as soon as it parses and reverted on blur if it never does.
 */
export function HexInput(props: {
  value: string;
  onChange: (v: string) => void;
  className?: string;
  title?: string;
}) {
  const [draft, setDraft] = useState(props.value);
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setDraft(props.value);
  }, [props.value]);

  return (
    <input
      className={props.className ?? "hex"}
      type="text"
      spellCheck={false}
      autoComplete="off"
      title={props.title}
      value={draft}
      onFocus={(e) => {
        focused.current = true;
        e.target.select();
      }}
      onChange={(e) => {
        setDraft(e.target.value);
        const hex = normalizeHex(e.target.value);
        if (hex) props.onChange(hex);
      }}
      onBlur={(e) => {
        focused.current = false;
        const hex = normalizeHex(e.target.value);
        setDraft(hex ?? props.value);
        if (hex) props.onChange(hex);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setDraft(props.value);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

// --------------------------------------------------------------------------
// the picker
// --------------------------------------------------------------------------
type EyeDropperLike = { open: () => Promise<{ sRGBHex: string }> };

const SWATCHES = [
  "#FFFFFF", "#C9CED6", "#5B6472", "#000000",
  "#2FFF74", "#369052", "#7CC7FF", "#1B6FB8",
  "#FFD166", "#F4845F", "#D6455D", "#8B5CF6",
];

export function ColorPicker(props: {
  value: string;
  onChange: (hex: string) => void;
  disabled?: boolean;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(props.value));
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const svRef = useRef<HTMLDivElement>(null);
  const hueRef = useRef<HTMLDivElement>(null);
  const emitted = useRef(props.value);

  // follow the parameter unless this picker is the one that changed it, which
  // keeps hue and saturation alive while dragging through black or gray
  useEffect(() => {
    if (props.value.toUpperCase() !== emitted.current.toUpperCase()) {
      emitted.current = props.value;
      setHsv(hexToHsv(props.value));
    }
  }, [props.value]);

  const commit = useCallback(
    (next: Hsv) => {
      setHsv(next);
      const hex = hsvToHex(next);
      emitted.current = hex;
      props.onChange(hex);
    },
    [props]
  );

  const place = useCallback(() => {
    const b = buttonRef.current?.getBoundingClientRect();
    if (!b) return;
    const width = 226;
    const height = 268;
    const left = Math.min(Math.max(8, b.left), window.innerWidth - width - 8);
    const below = b.bottom + 6;
    const top = below + height > window.innerHeight ? Math.max(8, b.top - height - 6) : below;
    setPos({ left, top });
  }, []);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || buttonRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onMove = () => place();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [open, place]);

  const dragSv = (e: React.PointerEvent) => {
    const r = svRef.current!.getBoundingClientRect();
    commit({
      ...hsv,
      s: clamp01((e.clientX - r.left) / r.width),
      v: 1 - clamp01((e.clientY - r.top) / r.height),
    });
  };
  const dragHue = (e: React.PointerEvent) => {
    const r = hueRef.current!.getBoundingClientRect();
    commit({ ...hsv, h: clamp01((e.clientX - r.left) / r.width) * 360 });
  };

  const hueHex = hsvToHex({ h: hsv.h, s: 1, v: 1 });
  const [r, g, b] = hexToRgb(props.value);

  const eyeDropper =
    typeof window !== "undefined" && "EyeDropper" in window
      ? () => {
          const ED = (window as unknown as { EyeDropper: new () => EyeDropperLike }).EyeDropper;
          new ED()
            .open()
            .then((res) => {
              const hex = normalizeHex(res.sRGBHex);
              if (hex) {
                emitted.current = hex;
                setHsv(hexToHsv(hex));
                props.onChange(hex);
                remember(hex);
              }
            })
            .catch(() => undefined);
        }
      : null;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="swatch"
        disabled={props.disabled}
        title={props.title ?? "pick a color"}
        style={{ background: props.value }}
        onClick={() => {
          if (props.disabled) return;
          setHsv(hexToHsv(props.value));
          setOpen((o) => !o);
        }}
      />
      {open &&
        createPortal(
          <div
            ref={popRef}
            className="picker"
            style={{ left: pos.left, top: pos.top }}
            onPointerUp={() => remember(hsvToHex(hsv))}
          >
            <div
              ref={svRef}
              className="sv"
              tabIndex={0}
              style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hueHex})` }}
              onPointerDown={(e) => {
                (e.target as Element).setPointerCapture(e.pointerId);
                dragSv(e);
              }}
              onPointerMove={(e) => {
                if (e.buttons === 1) dragSv(e);
              }}
              onKeyDown={(e) => {
                const step = e.shiftKey ? 0.1 : 0.02;
                if (e.key === "ArrowLeft") commit({ ...hsv, s: clamp01(hsv.s - step) });
                else if (e.key === "ArrowRight") commit({ ...hsv, s: clamp01(hsv.s + step) });
                else if (e.key === "ArrowUp") commit({ ...hsv, v: clamp01(hsv.v + step) });
                else if (e.key === "ArrowDown") commit({ ...hsv, v: clamp01(hsv.v - step) });
                else return;
                e.preventDefault();
              }}
            >
              <span
                className="knob"
                style={{
                  left: `${hsv.s * 100}%`,
                  top: `${(1 - hsv.v) * 100}%`,
                  background: props.value,
                }}
              />
            </div>

            <div
              ref={hueRef}
              className="hue"
              tabIndex={0}
              onPointerDown={(e) => {
                (e.target as Element).setPointerCapture(e.pointerId);
                dragHue(e);
              }}
              onPointerMove={(e) => {
                if (e.buttons === 1) dragHue(e);
              }}
              onKeyDown={(e) => {
                const step = e.shiftKey ? 15 : 3;
                if (e.key === "ArrowLeft") commit({ ...hsv, h: (hsv.h - step + 360) % 360 });
                else if (e.key === "ArrowRight") commit({ ...hsv, h: (hsv.h + step) % 360 });
                else return;
                e.preventDefault();
              }}
            >
              <span className="knob" style={{ left: `${(hsv.h / 360) * 100}%`, background: hueHex }} />
            </div>

            <div className="picker-row">
              <HexInput
                className="hex"
                value={props.value}
                onChange={(hex) => {
                  emitted.current = hex;
                  setHsv(hexToHsv(hex));
                  props.onChange(hex);
                  remember(hex);
                }}
              />
              {eyeDropper && (
                <button className="small" title="pick a color from the screen" onClick={eyeDropper}>
                  pipette
                </button>
              )}
            </div>
            <div className="picker-rgb">
              rgb {Math.round(r)}, {Math.round(g)}, {Math.round(b)}
            </div>

            <div className="picker-swatches">
              {[...recents, ...SWATCHES.filter((c) => !recents.includes(c))]
                .slice(0, 12)
                .map((c) => (
                  <button
                    key={c}
                    className="mini"
                    title={c}
                    style={{ background: c }}
                    onClick={() => {
                      emitted.current = c;
                      setHsv(hexToHsv(c));
                      props.onChange(c);
                      remember(c);
                    }}
                  />
                ))}
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
