"use client";

import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { PenLine, Redo2, Undo2, X } from "lucide-react";

export type Point = { x: number; y: number };
export type Stroke = Point[];

export type AnnotationState = { strokes: Stroke[]; past: Stroke[][]; future: Stroke[][] };

export type AnnotationAction =
  | { type: "add"; stroke: Stroke }
  | { type: "clear" }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "reset" };

export const EMPTY_ANNOTATIONS: AnnotationState = { strokes: [], past: [], future: [] };

export const ANNOTATION_COLOR = "#e5484d";

export function annotationReducer(state: AnnotationState, action: AnnotationAction): AnnotationState {
  switch (action.type) {
    case "add":
      if (action.stroke.length === 0) return state;
      return { strokes: [...state.strokes, action.stroke], past: [...state.past, state.strokes], future: [] };
    case "clear":
      if (state.strokes.length === 0) return state;
      return { strokes: [], past: [...state.past, state.strokes], future: [] };
    case "undo": {
      if (state.past.length === 0) return state;
      const previous = state.past[state.past.length - 1]!;
      return { strokes: previous, past: state.past.slice(0, -1), future: [state.strokes, ...state.future] };
    }
    case "redo": {
      if (state.future.length === 0) return state;
      const [next, ...rest] = state.future;
      return { strokes: next!, past: [...state.past, state.strokes], future: rest };
    }
    case "reset":
      return EMPTY_ANNOTATIONS;
  }
}

export function strokePath(stroke: Stroke): string {
  if (stroke.length === 0) return "";
  const [first, ...rest] = stroke;
  if (rest.length === 0) return `M ${first!.x} ${first!.y} l 0.01 0`;
  let d = `M ${first!.x} ${first!.y}`;
  for (let i = 0; i < rest.length - 1; i++) {
    const p = rest[i]!;
    const q = rest[i + 1]!;
    d += ` Q ${p.x} ${p.y} ${(p.x + q.x) / 2} ${(p.y + q.y) / 2}`;
  }
  const last = rest[rest.length - 1]!;
  return `${d} L ${last.x} ${last.y}`;
}

export function AnnotationCanvas({
  strokes,
  onStroke,
  strokeWidth = 3,
  color = ANNOTATION_COLOR,
  strokeOpacity,
}: {
  strokes: Stroke[];
  onStroke: (stroke: Stroke) => void;
  strokeWidth?: number;
  color?: string;
  strokeOpacity?: number;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [live, setLive] = useState<Stroke | null>(null);
  const liveRef = useRef<Stroke | null>(null);

  const pointFrom = useCallback((event: ReactPointerEvent) => {
    const rect = svgRef.current!.getBoundingClientRect();
    return { x: Math.round((event.clientX - rect.left) * 10) / 10, y: Math.round((event.clientY - rect.top) * 10) / 10 };
  }, []);

  const finish = useCallback(() => {
    const stroke = liveRef.current;
    liveRef.current = null;
    setLive(null);
    if (stroke && stroke.length > 0) onStroke(stroke);
  }, [onStroke]);

  return (
    <svg
      ref={svgRef}
      data-testid="annotation-canvas"
      aria-hidden
      className="absolute inset-0 z-[6] h-full w-full cursor-crosshair touch-none"
      onPointerDown={(event) => {
        if (event.button > 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        const stroke = [pointFrom(event)];
        liveRef.current = stroke;
        setLive(stroke);
      }}
      onPointerMove={(event) => {
        if (!liveRef.current) return;
        const point = pointFrom(event);
        const last = liveRef.current[liveRef.current.length - 1]!;
        if (Math.abs(point.x - last.x) + Math.abs(point.y - last.y) < 1.5) return;
        const stroke = [...liveRef.current, point];
        liveRef.current = stroke;
        setLive(stroke);
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
    >
      <g fill="none" stroke={color} strokeWidth={strokeWidth} strokeOpacity={strokeOpacity} strokeLinecap="round" strokeLinejoin="round">
        {strokes.map((stroke, i) => (
          <path key={i} d={strokePath(stroke)} />
        ))}
        {live && <path d={strokePath(live)} />}
      </g>
    </svg>
  );
}

export function AnnotationBar({
  canUndo,
  canRedo,
  canClear,
  onUndo,
  onRedo,
  onClear,
  onExit,
}: {
  canUndo: boolean;
  canRedo: boolean;
  canClear: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onClear: () => void;
  onExit: () => void;
}) {
  const quiet =
    "inline-flex h-9 w-9 items-center justify-center rounded-full text-inkMuted transition-colors hover:bg-bone hover:text-ink disabled:cursor-not-allowed disabled:text-inkLight disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30";
  return (
    <div className="flex items-center gap-1 animate-pane-fade motion-reduce:animate-none">
      <button
        type="button"
        onClick={onExit}
        aria-pressed
        aria-label="Stop annotating"
        className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-ink text-cream transition-colors hover:bg-ink/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
      >
        <PenLine className="h-4 w-4" aria-hidden />
      </button>
      <span className="px-1.5 text-[13px] font-semibold text-ink">Annotation</span>
      <button type="button" onClick={onUndo} disabled={!canUndo} aria-label="Undo stroke" className={quiet}>
        <Undo2 className="h-4 w-4" aria-hidden />
      </button>
      <button type="button" onClick={onRedo} disabled={!canRedo} aria-label="Redo stroke" className={quiet}>
        <Redo2 className="h-4 w-4" aria-hidden />
      </button>
      <button
        type="button"
        onClick={onClear}
        disabled={!canClear}
        className="inline-flex h-9 items-center rounded-full px-3.5 text-[13px] font-semibold text-ink transition-colors hover:bg-bone disabled:cursor-not-allowed disabled:text-inkLight disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
      >
        Clear
      </button>
      <button type="button" onClick={onExit} aria-label="Close annotation" className={quiet}>
        <X className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}
