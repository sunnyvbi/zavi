"use client";

import { useEffect, useRef } from "react";
import { WORDMARK_PATH, WORDMARK_VIEWBOX } from "./ZaviWordmark";

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (lo: number, hi: number, v: number) => {
  const t = clamp01((v - lo) / (hi - lo));
  return t * t * (3 - 2 * t);
};

const SAMPLES = 8;

const I_DOT_START = WORDMARK_PATH.indexOf("M195.03 7.9688");
const I_STEM_START = WORDMARK_PATH.indexOf("M210.968 85.9408");
const SPLIT_I = I_DOT_START > 0 && I_STEM_START > I_DOT_START;
const BODY_PATH = SPLIT_I ? WORDMARK_PATH.slice(0, I_DOT_START) : WORDMARK_PATH;
const I_STEM = { left: 195.03, right: 210.968, top: 20.9642, bottom: 85.9408 };

export function DotWordmark({ rows = 14, pitch = 24, className = "" }: { rows?: number; pitch?: number; className?: string }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!wrap || !canvas || !ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let cell = pitch;
    let height = rows * cell;
    let hoverRadius = 5.5 * cell;
    let width = 0;
    let cols = 0;
    let offsetX = 0;
    let coverage = new Float32Array(0);
    let noise = new Float32Array(0);
    let revealStart = -1;
    let raf = 0;
    let inView = false;
    let hovering = false;
    const pointer = { x: -1e9, y: -1e9 };

    function draw(now: number) {
      if (!width) return;
      ctx!.clearRect(0, 0, width, height);
      const progress = reduced ? 1 : revealStart < 0 ? 0 : clamp01((now - revealStart) / 1600);
      const front = (1 - Math.pow(1 - progress, 3)) * (cols + 10);
      const baseR = 0.21 * cell;
      for (let r = 0; r < rows; r++) {
        const cy = r * cell + cell / 2;
        for (let c = 0; c < cols; c++) {
          const i = r * cols + c;
          const cx = offsetX + c * cell;
          const ink = smoothstep(0.25, 0.6, coverage[i]) * clamp01((front - c) / 8);
          let alpha = 0.13 + 0.82 * ink;
          let radius = baseR * (1 + 0.15 * ink);
          if (!reduced && noise[i] > 0.93) {
            const s = 0.5 + 0.5 * Math.sin(0.0012 * now + 200 * noise[i]);
            alpha += 0.32 * s * s * s;
          }
          const dx = cx - pointer.x;
          const dy = cy - pointer.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < hoverRadius * hoverRadius) {
            const f = 1 - Math.sqrt(d2) / hoverRadius;
            const f2 = f * f;
            alpha += 0.7 * f2;
            radius *= 1 + 0.7 * f2;
          }
          ctx!.fillStyle = `rgba(14,15,17,${Math.min(alpha, 1).toFixed(3)})`;
          ctx!.beginPath();
          ctx!.arc(cx, cy, radius, 0, 2 * Math.PI);
          ctx!.fill();
        }
      }
    }

    function rasteriseWordmark() {
      coverage = new Float32Array(cols * rows);
      if (typeof Path2D === "undefined") return;
      const off = document.createElement("canvas");
      off.width = SAMPLES * cols;
      off.height = SAMPLES * rows;
      const octx = off.getContext("2d");
      if (!octx) return;
      const scale = Math.min(
        (SAMPLES * Math.min(rows - 2, 12)) / WORDMARK_VIEWBOX.h,
        (SAMPLES * cols - 16) / WORDMARK_VIEWBOX.w,
      );
      if (scale <= 0) return;
      const w = WORDMARK_VIEWBOX.w * scale;
      const h = WORDMARK_VIEWBOX.h * scale;
      const x = SAMPLES * Math.round((off.width - w) / 2 / SAMPLES);
      const y = SAMPLES * Math.round((off.height - h) / 2 / SAMPLES);
      octx.setTransform(scale, 0, 0, scale, x, y);
      octx.fillStyle = "#000";
      octx.fill(new Path2D(BODY_PATH));
      const px = octx.getImageData(0, 0, off.width, off.height).data;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          let hits = 0;
          for (let sy = 0; sy < SAMPLES; sy++) {
            for (let sx = 0; sx < SAMPLES; sx++) {
              if (px[((SAMPLES * r + sy) * off.width + (SAMPLES * c + sx)) * 4 + 3] > 127) hits++;
            }
          }
          coverage[r * cols + c] = hits / (SAMPLES * SAMPLES);
        }
      }
      if (SPLIT_I) {
        const left = x + I_STEM.left * scale;
        const right = x + I_STEM.right * scale;
        const top = y + I_STEM.top * scale;
        const bottom = y + I_STEM.bottom * scale;
        const n = Math.max(1, Math.round((right - left) / SAMPLES));
        const first = Math.round((left + right) / 2 / SAMPLES - n / 2);
        const stemRow = Math.floor(top / SAMPLES);
        const dotRow = stemRow - 2;
        for (let c = Math.max(0, first); c < Math.min(cols, first + n); c++) {
          for (let r = 0; r < rows; r++) {
            const v = clamp01((Math.min(bottom, (r + 1) * SAMPLES) - Math.max(top, r * SAMPLES)) / SAMPLES);
            const ink = r === dotRow ? 1 : v;
            if (ink > coverage[r * cols + c]) coverage[r * cols + c] = ink;
          }
        }
      }
    }

    function resize() {
      width = wrap!.clientWidth;
      if (!width) return;
      cell = width < 520 ? Math.max(12, Math.floor(width / 22)) : pitch;
      height = rows * cell;
      hoverRadius = 5.5 * cell;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      cols = Math.max(1, Math.floor(width / cell));
      offsetX = (width - cols * cell) / 2 + cell / 2;
      canvas!.width = Math.round(width * dpr);
      canvas!.height = Math.round(height * dpr);
      canvas!.style.width = `${width}px`;
      canvas!.style.height = `${height}px`;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      noise = new Float32Array(cols * rows);
      for (let i = 0; i < noise.length; i++) noise[i] = Math.random();
      rasteriseWordmark();
      draw(performance.now());
    }

    function frame(now: number) {
      draw(now);
      raf = requestAnimationFrame(frame);
    }

    function syncLoop() {
      const shouldRun = inView && document.visibilityState === "visible" && (!reduced || hovering);
      if (shouldRun) {
        if (!raf) raf = requestAnimationFrame(frame);
      } else {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        draw(performance.now());
      }
    }

    const io = new IntersectionObserver(
      ([entry]) => {
        inView = entry.isIntersecting;
        if (inView && revealStart < 0) revealStart = performance.now();
        syncLoop();
      },
      { threshold: 0.15 },
    );
    io.observe(wrap);
    const ro = new ResizeObserver(() => resize());
    ro.observe(wrap);

    const onMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      pointer.x = e.clientX - rect.left;
      pointer.y = e.clientY - rect.top;
      hovering = true;
      syncLoop();
    };
    const onLeave = () => {
      pointer.x = -1e9;
      pointer.y = -1e9;
      hovering = false;
      syncLoop();
    };
    wrap.addEventListener("pointermove", onMove);
    wrap.addEventListener("pointerleave", onLeave);
    document.addEventListener("visibilitychange", syncLoop);
    resize();

    return () => {
      if (raf) cancelAnimationFrame(raf);
      io.disconnect();
      ro.disconnect();
      wrap.removeEventListener("pointermove", onMove);
      wrap.removeEventListener("pointerleave", onLeave);
      document.removeEventListener("visibilitychange", syncLoop);
    };
  }, [rows, pitch]);

  return (
    <div ref={wrapRef} className={`w-full ${className}`} aria-hidden="true">
      <canvas ref={canvasRef} className="block" />
    </div>
  );
}
