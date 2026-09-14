import { useEffect, useRef, useState } from "react";
import { gradientField } from "../lib/ops";
import { stopAnchor, type GradientStop } from "../lib/params";

const PREVIEW = 96;
const SNAP = 0.045;
const ANCHORS = [0, 0.5, 1];

/**
 * Anchor editor for the point gradient.
 *
 * The preview is the same field the renderer uses, so what is dragged here is
 * what comes out. Anchors snap to the nine usual spots (corners, edge centers,
 * center) when dropped close to one, which is how "green at top center, blue at
 * middle left" gets placed exactly rather than approximately.
 */
export function GradientPad(props: {
  stops: GradientStop[];
  sharpness: number;
  onChange: (stops: GradientStop[]) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const anchors = props.stops.map((s) => {
      const [x, y] = stopAnchor(s);
      return { x, y, color: s.color };
    });
    const field = gradientField(anchors, PREVIEW, props.sharpness);
    const img = new ImageData(PREVIEW, PREVIEW);
    for (let i = 0; i < PREVIEW * PREVIEW; i++) {
      img.data[i * 4] = field[i * 3];
      img.data[i * 4 + 1] = field[i * 3 + 1];
      img.data[i * 4 + 2] = field[i * 3 + 2];
      img.data[i * 4 + 3] = 255;
    }
    canvas.width = PREVIEW;
    canvas.height = PREVIEW;
    canvas.getContext("2d")!.putImageData(img, 0, 0);
  }, [props.stops, props.sharpness]);

  const move = (index: number, clientX: number, clientY: number) => {
    const r = boxRef.current!.getBoundingClientRect();
    let x = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    let y = Math.min(1, Math.max(0, (clientY - r.top) / r.height));
    for (const a of ANCHORS) {
      if (Math.abs(x - a) < SNAP) x = a;
      if (Math.abs(y - a) < SNAP) y = a;
    }
    props.onChange(props.stops.map((s, i) => (i === index ? { ...s, x, y } : s)));
  };

  return (
    <div className="pad" ref={boxRef}>
      <canvas ref={canvasRef} />
      <div className="pad-guides" />
      {props.stops.map((s, i) => {
        const [x, y] = stopAnchor(s);
        return (
          <span
            key={i}
            className={"pad-dot" + (dragging === i ? " active" : "")}
            style={{ left: `${x * 100}%`, top: `${y * 100}%`, background: s.color }}
            title={`color ${i + 1}, drag to place`}
            onPointerDown={(e) => {
              (e.target as Element).setPointerCapture(e.pointerId);
              setDragging(i);
              move(i, e.clientX, e.clientY);
            }}
            onPointerMove={(e) => {
              if (dragging === i) move(i, e.clientX, e.clientY);
            }}
            onPointerUp={() => setDragging(null)}
          />
        );
      })}
    </div>
  );
}
