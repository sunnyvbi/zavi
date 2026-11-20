"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

const DRIFT_PX_PER_SEC = 16;

export function MarqueeRow({ children }: { children: ReactNode }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const pausedRef = useRef(false);
  const dragRef = useRef<{ id: number; x: number; from: number } | null>(null);
  const draggedRef = useRef(false);
  const offsetRef = useRef(0);
  const lapRef = useRef(0);

  useEffect(() => {
    const viewport = viewportRef.current;
    const track = trackRef.current;
    if (!viewport || !track) return;
    const measure = () => {
      const copies = track.children;
      const lap =
        copies.length > 1
          ? (copies[1] as HTMLElement).offsetLeft - (copies[0] as HTMLElement).offsetLeft
          : track.scrollWidth;
      lapRef.current = lap;
      setOverflows((copies[0] as HTMLElement | undefined)?.offsetWidth
        ? (copies[0] as HTMLElement).offsetWidth > viewport.clientWidth + 1
        : track.scrollWidth > viewport.clientWidth + 1);
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(viewport);
    observer?.observe(track);
    return () => observer?.disconnect();
  }, [children, overflows]);

  useEffect(() => {
    const track = trackRef.current;
    if (!overflows || !track) {
      offsetRef.current = 0;
      if (track) track.style.transform = "";
      return;
    }
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

    let frame = 0;
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      if (!pausedRef.current) advance(DRIFT_PX_PER_SEC * dt);
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overflows]);

  const advance = useCallback((dx: number) => {
    const track = trackRef.current;
    const lap = lapRef.current;
    if (!track || lap <= 0) return;
    let next = (offsetRef.current + dx) % lap;
    if (next < 0) next += lap;
    offsetRef.current = next;
    track.style.transform = `translate3d(${-next}px,0,0)`;
  }, []);

  const pause = useCallback(() => {
    pausedRef.current = true;
  }, []);
  const resume = useCallback(() => {
    if (!dragRef.current) pausedRef.current = false;
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !overflows) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      e.preventDefault();
      advance(e.deltaX);
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, [overflows, advance]);

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!overflows) return;
    dragRef.current = { id: e.pointerId, x: e.clientX, from: offsetRef.current };
    draggedRef.current = false;
    pausedRef.current = true;
  }, [overflows]);

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.id !== e.pointerId) return;
      const dx = e.clientX - drag.x;
      if (Math.abs(dx) < 3) return;
      draggedRef.current = true;
      viewportRef.current?.setPointerCapture?.(e.pointerId);
      advance(drag.from - dx - offsetRef.current);
    },
    [advance],
  );

  const endDrag = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.id !== e.pointerId) return;
    const viewport = viewportRef.current;
    viewport?.releasePointerCapture?.(e.pointerId);
    dragRef.current = null;
    const r = viewport?.getBoundingClientRect();
    const inside =
      !!r &&
      e.clientX >= r.left &&
      e.clientX <= r.right &&
      e.clientY >= r.top &&
      e.clientY <= r.bottom;
    pausedRef.current = e.pointerType !== "touch" && inside;
  }, []);

  const onClickCapture = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    if (!draggedRef.current) return;
    draggedRef.current = false;
    e.preventDefault();
    e.stopPropagation();
  }, []);

  return (
    <div
      ref={viewportRef}
      className={`w-full overflow-hidden ${
        overflows
          ?
            "touch-pan-y cursor-grab active:cursor-grabbing [mask-image:linear-gradient(to_right,transparent,black_28px,black_calc(100%-28px),transparent)]"
          : ""
      }`}
      onPointerEnter={pause}
      onPointerLeave={(e) => {
        endDrag(e);
        resume();
      }}
      onFocusCapture={pause}
      onBlurCapture={resume}
      onClickCapture={onClickCapture}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <div
        ref={trackRef}
        className={`flex w-max gap-2 py-1 will-change-transform ${
          overflows ? "" : "mx-auto"
        }`}
      >
        {}
        <div className="flex gap-2">{children}</div>
        {}
        {overflows ? (
          <div className="flex gap-2" aria-hidden="true">
            {children}
          </div>
        ) : null}
      </div>
    </div>
  );
}
