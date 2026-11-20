"use client";

import { createDragButtonWatch } from "./dragButtonWatch";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from "react";

export type ClampRounding = "none" | "max" | "result";

export type ClampSpec = {
  min: number;
  maxPx?: number;
  maxFraction?: number;
  maxFn?: (viewport: number) => number;
  round?: ClampRounding;
};

export type KeyboardResizeOptions = {
  step?: number;
  largeStep?: number;
  homeEndKeys?: boolean;
};

export type UseResizablePaneOptions = ClampSpec & {
  containerRef?: RefObject<HTMLElement | null>;
  anchor?: "left" | "right";
  storageKey?: string;
  defaultPx?: number;
  defaultFn?: (viewport: number) => number;
  initialSizePx?: number | null;
  rehydrate?: boolean;
  reclampOnResize?: boolean;
  setBodyCursor?: boolean;
  trackDragging?: boolean;
  permanentListeners?: boolean;
  resetTo?: number | ((current: number | null, viewport: number) => number);
  resetOnDoubleClick?: boolean;
  ariaLabel?: string;
  keyboard?: boolean | KeyboardResizeOptions;
  exposeAriaValues?: boolean;
  onCommit?: (sizePct: number, sizePx: number) => void;
};

export type SeparatorProps = {
  role: "separator";
  "aria-orientation": "vertical";
  "aria-label": string;
  onMouseDown: (e: ReactMouseEvent) => void;
  onDoubleClick?: () => void;
  onKeyDown?: (e: ReactKeyboardEvent) => void;
  tabIndex?: number;
  "aria-valuenow"?: number;
  "aria-valuemin"?: number;
  "aria-valuemax"?: number;
  "aria-valuetext"?: string;
};

export type UseResizablePaneResult = {
  sizePx: number | null;
  sizePct: number | null;
  dragging: boolean;
  startResize: (e: ReactMouseEvent) => void;
  resetSize: () => void;
  setSize: (px: number) => void;
  separatorProps: SeparatorProps;
};

export function makeClamp(spec: ClampSpec): (px: number, viewport: number) => number {
  const { min, maxPx, maxFraction, maxFn, round = "none" } = spec;
  return (px: number, viewport: number): number => {
    let ceiling: number;
    if (maxFn) ceiling = maxFn(viewport);
    else if (maxFraction !== undefined) ceiling = viewport * maxFraction;
    else if (maxPx !== undefined) ceiling = maxPx;
    else ceiling = Number.POSITIVE_INFINITY;

    if (round === "max" && Number.isFinite(ceiling)) ceiling = Math.round(ceiling);

    const max = Math.max(min, ceiling);
    const clamped = Math.min(max, Math.max(min, px));
    return round === "result" ? Math.round(clamped) : clamped;
  };
}

function readViewport(): number {
  return typeof window === "undefined" ? 0 : window.innerWidth;
}

function readBounds(containerRef?: RefObject<HTMLElement | null>): {
  width: number;
  right: number;
  left: number;
} {
  const el = containerRef?.current;
  if (el) {
    const rect = el.getBoundingClientRect();
    const width = el.clientWidth || rect.width;
    if (width > 0) return { width, right: rect.right, left: rect.left };
  }
  const width = readViewport();
  return { width, right: width, left: 0 };
}

export function paneSizeFromPointer(
  anchor: "left" | "right",
  bounds: { left: number; right: number },
  clientX: number,
): number {
  return anchor === "left" ? clientX - bounds.left : bounds.right - clientX;
}

export function growKeyFor(anchor: "left" | "right"): "ArrowLeft" | "ArrowRight" {
  return anchor === "left" ? "ArrowRight" : "ArrowLeft";
}

export function useResizablePane(
  options: UseResizablePaneOptions,
): UseResizablePaneResult {
  const {
    anchor = "right",
    containerRef,
    storageKey,
    defaultPx,
    defaultFn,
    initialSizePx = defaultPx ?? null,
    rehydrate = !!storageKey,
    reclampOnResize = true,
    setBodyCursor = true,
    trackDragging = true,
    permanentListeners = false,
    resetTo,
    resetOnDoubleClick = resetTo !== undefined,
    ariaLabel = "Resize panel",
    keyboard = false,
    exposeAriaValues = !!keyboard,
    onCommit,
    min,
    maxPx,
    maxFraction,
    maxFn,
    round,
  } = options;

  const clamp = useMemo(
    () => makeClamp({ min, maxPx, maxFraction, maxFn, round }),
    [min, maxPx, maxFraction, maxFn, round],
  );

  const [sizePx, setSizePxState] = useState<number | null>(initialSizePx);
  const [dragging, setDragging] = useState(false);
  const [viewport, setViewport] = useState(0);

  const sizeRef = useRef<number | null>(initialSizePx);
  const draggingRef = useRef(false);

  const clampRef = useRef(clamp);
  clampRef.current = clamp;
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;

  const writeSize = useCallback((next: number) => {
    sizeRef.current = next;
    setSizePxState(next);
  }, []);

  const persist = useCallback(
    (px: number) => {
      if (storageKey) {
        try {
          window.localStorage.setItem(storageKey, String(px));
        } catch {
        }
      }
      const vw = readBounds(containerRef).width;
      onCommitRef.current?.(vw > 0 ? (px / vw) * 100 : 0, px);
    },
    [containerRef, storageKey],
  );

  const defaultFor = useCallback(
    (vw: number): number => {
      if (defaultFn) return defaultFn(vw);
      if (defaultPx !== undefined) return defaultPx;
      return min;
    },
    [defaultFn, defaultPx, min],
  );

  useEffect(() => {
    const vw = readBounds(containerRef).width;
    setViewport(vw);

    let saved = NaN;
    if (rehydrate && storageKey) {
      try {
        saved = Number(window.localStorage.getItem(storageKey));
      } catch {
        saved = NaN;
      }
    }
    const hasSaved = Number.isFinite(saved) && saved > 0;

    if (!hasSaved && !rehydrate && sizeRef.current !== null) return;

    const raw = hasSaved ? saved : defaultFor(vw);
    writeSize(clampRef.current(raw, vw));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!reclampOnResize) return;
    const onResize = () => {
      const vw = readBounds(containerRef).width;
      setViewport(vw);
      const current = sizeRef.current;
      if (current === null) return;
      writeSize(clampRef.current(current, vw));
    };
    window.addEventListener("resize", onResize);
    const container = containerRef?.current;
    const observer =
      container && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(onResize)
        : null;
    observer?.observe(container!);
    return () => {
      window.removeEventListener("resize", onResize);
      observer?.disconnect();
    };
  }, [containerRef, reclampOnResize, writeSize]);

  const buttonWatchRef = useRef(createDragButtonWatch());

  const handleMove = useCallback(
    (ev: MouseEvent) => {
      if (!draggingRef.current) return;
      const bounds = readBounds(containerRef);
      const vw = bounds.width;
      writeSize(
        clampRef.current(paneSizeFromPointer(anchorRef.current, bounds, ev.clientX), vw),
      );
    },
    [containerRef, writeSize],
  );

  const endDrag = useCallback(() => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    if (trackDragging) setDragging(false);
    document.body.style.userSelect = "";
    if (setBodyCursor) document.body.style.cursor = "";
    const current = sizeRef.current;
    if (current !== null) persist(current);
  }, [persist, setBodyCursor, trackDragging]);

  useEffect(() => {
    if (!permanentListeners) return;
    const move = (ev: MouseEvent) => {
      if (draggingRef.current && !buttonWatchRef.current(ev.buttons)) {
        endDrag();
        return;
      }
      handleMove(ev);
    };
    const up = () => endDrag();
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [permanentListeners, handleMove, endDrag]);

  const startResize = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      buttonWatchRef.current = createDragButtonWatch();
      draggingRef.current = true;
      if (trackDragging) setDragging(true);
      document.body.style.userSelect = "none";
      if (setBodyCursor) document.body.style.cursor = "col-resize";
      if (permanentListeners) return;

      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        endDrag();
      };
      const onMove = (ev: MouseEvent) => {
        if (!buttonWatchRef.current(ev.buttons)) {
          onUp();
          return;
        }
        handleMove(ev);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [endDrag, handleMove, permanentListeners, setBodyCursor, trackDragging],
  );

  const setSize = useCallback(
    (px: number) => {
      const vw = readBounds(containerRef).width;
      const next = clampRef.current(px, vw);
      writeSize(next);
      persist(next);
    },
    [containerRef, persist, writeSize],
  );

  const resetSize = useCallback(() => {
    if (resetTo === undefined) return;
    const vw = readBounds(containerRef).width;
    const raw =
      typeof resetTo === "function" ? resetTo(sizeRef.current, vw) : resetTo;
    const next = clampRef.current(raw, vw);
    writeSize(next);
    persist(next);
  }, [containerRef, persist, resetTo, writeSize]);

  const kb: Required<KeyboardResizeOptions> | null = useMemo(() => {
    if (!keyboard) return null;
    const o = typeof keyboard === "object" ? keyboard : {};
    return {
      step: o.step ?? 16,
      largeStep: o.largeStep ?? 64,
      homeEndKeys: o.homeEndKeys ?? true,
    };
  }, [keyboard]);

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent) => {
      if (!kb) return;
      const vw = readBounds(containerRef).width;
      const current = sizeRef.current ?? clampRef.current(defaultFor(vw), vw);
      let next: number | null = null;
      const grow = growKeyFor(anchorRef.current);
      switch (e.key) {
        case "ArrowLeft":
          next = e.key === grow ? current + kb.step : current - kb.step;
          break;
        case "ArrowRight":
          next = e.key === grow ? current + kb.step : current - kb.step;
          break;
        case "PageUp":
          next = current + kb.largeStep;
          break;
        case "PageDown":
          next = current - kb.largeStep;
          break;
        case "Home":
          if (kb.homeEndKeys) next = min;
          break;
        case "End":
          if (kb.homeEndKeys) next = Number.MAX_SAFE_INTEGER;
          break;
        default:
          break;
      }
      if (next === null) return;
      e.preventDefault();
      setSize(next);
    },
    [containerRef, defaultFor, kb, min, setSize],
  );

  const sizePct = viewport > 0 && sizePx !== null ? (sizePx / viewport) * 100 : null;

  const separatorProps = useMemo<SeparatorProps>(() => {
    const props: SeparatorProps = {
      role: "separator",
      "aria-orientation": "vertical",
      "aria-label": ariaLabel,
      onMouseDown: startResize,
    };
    if (resetOnDoubleClick) props.onDoubleClick = resetSize;
    if (kb) {
      props.onKeyDown = onKeyDown;
      props.tabIndex = 0;
    }
    if (exposeAriaValues && sizePx !== null && viewport > 0) {
      const max = clamp(Number.MAX_SAFE_INTEGER, viewport);
      props["aria-valuenow"] = Math.round(sizePx);
      props["aria-valuemin"] = Math.round(min);
      props["aria-valuemax"] = Math.round(max);
      props["aria-valuetext"] = `${Math.round(sizePx)} pixels`;
    }
    return props;
  }, [
    ariaLabel,
    clamp,
    exposeAriaValues,
    kb,
    min,
    onKeyDown,
    resetOnDoubleClick,
    resetSize,
    sizePx,
    startResize,
    viewport,
  ]);

  return { sizePx, sizePct, dragging, startResize, resetSize, setSize, separatorProps };
}
