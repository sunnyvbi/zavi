"use client";

import { useReducer, useState } from "react";
import { Loader2, Redo2, Undo2, X } from "lucide-react";
import { AnnotationCanvas, EMPTY_ANNOTATIONS, annotationReducer, type Stroke } from "./PreviewAnnotation";
import type { SitePhotoPreview } from "@/lib/workspace/siteDesignEdit";

export const MASK_MAX_BYTES = 700 * 1024;
export const MASK_BRUSH = 28;
const PAINTER_MAX = 300;
const PNG_PREFIX = "data:image/png;base64,";

type Size = { width: number; height: number };

export function painterSize(photo: Size, max = PAINTER_MAX): Size {
  const scale = Math.min(1, max / photo.width, max / photo.height);
  return { width: Math.max(1, Math.round(photo.width * scale)), height: Math.max(1, Math.round(photo.height * scale)) };
}

function traceStroke(ctx: CanvasRenderingContext2D, stroke: Stroke): void {
  const [first, ...rest] = stroke;
  if (!first) return;
  ctx.beginPath();
  ctx.moveTo(first.x, first.y);
  if (rest.length === 0) ctx.lineTo(first.x + 0.01, first.y);
  for (let i = 0; i < rest.length - 1; i++) {
    const p = rest[i]!;
    const q = rest[i + 1]!;
    ctx.quadraticCurveTo(p.x, p.y, (p.x + q.x) / 2, (p.y + q.y) / 2);
  }
  const last = rest[rest.length - 1];
  if (last) ctx.lineTo(last.x, last.y);
  ctx.stroke();
}

export function maskDataUrl(strokes: Stroke[], display: Size, natural: Size, brush = MASK_BRUSH, maxBytes = MASK_MAX_BYTES): string | null {
  if (strokes.length === 0) return null;
  for (const scale of [1, 0.5, 0.25]) {
    const width = Math.max(1, Math.round(natural.width * scale));
    const height = Math.max(1, Math.round(natural.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.clearRect(0, 0, width, height);
    ctx.scale(width / display.width, height / display.height);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = brush;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const stroke of strokes) traceStroke(ctx, stroke);
    const url = canvas.toDataURL("image/png");
    if (!url.startsWith(PNG_PREFIX)) return null;
    if (Math.floor(((url.length - PNG_PREFIX.length) * 3) / 4) <= maxBytes) return url;
  }
  return null;
}

export function PhotoMaskPainter({
  photo,
  busy,
  canApply,
  onApply,
  onCancel,
}: {
  photo: SitePhotoPreview;
  busy: boolean;
  canApply: boolean;
  onApply: (mask: string) => void;
  onCancel: () => void;
}) {
  const [state, dispatch] = useReducer(annotationReducer, EMPTY_ANNOTATIONS);
  const [problem, setProblem] = useState<string | null>(null);
  const size = painterSize(photo);
  const painted = state.strokes.length > 0;
  const quiet =
    "inline-flex h-7 w-7 items-center justify-center rounded-full text-inkMuted hover:bg-bone hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent";

  const apply = () => {
    const mask = maskDataUrl(state.strokes, size, photo);
    if (!mask) {
      setProblem("We couldn't read the brushed area. Clear it and brush again.");
      return;
    }
    setProblem(null);
    onApply(mask);
  };

  return (
    <div className="flex w-fit flex-col gap-2 rounded-[12px] border border-rule bg-cream p-2 text-ink" aria-label="Change part of this photo">
      <span className="text-[12px] text-inkMuted">Brush over the part to change, then describe the change above.</span>
      <div className={`relative overflow-hidden rounded-[8px] ${busy ? "pointer-events-none opacity-60" : ""}`} style={{ width: size.width, height: size.height }}>
        <img src={photo.data_url} alt="The photo to change" width={size.width} height={size.height} draggable={false} className="block h-full w-full select-none" />
        <AnnotationCanvas
          strokes={state.strokes}
          onStroke={(stroke) => {
            setProblem(null);
            dispatch({ type: "add", stroke });
          }}
          strokeWidth={MASK_BRUSH}
          strokeOpacity={0.5}
        />
      </div>
      <div className="flex items-center gap-1">
        <button type="button" onClick={() => dispatch({ type: "undo" })} disabled={busy || state.past.length === 0} aria-label="Undo brush stroke" className={quiet}>
          <Undo2 className="h-3.5 w-3.5" aria-hidden />
        </button>
        <button type="button" onClick={() => dispatch({ type: "redo" })} disabled={busy || state.future.length === 0} aria-label="Redo brush stroke" className={quiet}>
          <Redo2 className="h-3.5 w-3.5" aria-hidden />
        </button>
        <button
          type="button"
          onClick={() => dispatch({ type: "clear" })}
          disabled={busy || !painted}
          className="inline-flex h-7 items-center rounded-full px-2.5 text-[12px] font-semibold text-ink hover:bg-bone disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
        >
          Clear
        </button>
        <span className="flex-1" />
        <button type="button" onClick={onCancel} disabled={busy} aria-label="Stop changing part of the photo" className={quiet}>
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
        <button
          type="button"
          onClick={apply}
          disabled={busy || !painted || !canApply}
          className="inline-flex h-7 items-center gap-1 rounded-full bg-ink px-3 text-[12px] font-semibold text-cream hover:bg-ink/85 disabled:opacity-50"
        >
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />}
          Change this part
        </button>
      </div>
      {problem && (
        <span role="alert" className="text-[12px] text-[#cb2029]">
          {problem}
        </span>
      )}
    </div>
  );
}
