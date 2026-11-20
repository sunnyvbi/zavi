"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { FOCUS_RING, useModalFocusTrap } from "./layout/shared";

const TTL_MS = 540_000;
const MAX_ENTRIES = 48;

type Entry = { url: string; expiresAt: number };

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<string | null>>();
const mounted = new Map<string, number>();
const releaseTimers = new Map<string, ReturnType<typeof setTimeout>>();

function removeCached(path: string) {
  const entry = cache.get(path);
  cache.delete(path);
  if (entry?.url.startsWith("blob:")) URL.revokeObjectURL(entry.url);
}

function cancelRelease(path: string) {
  const timer = releaseTimers.get(path);
  if (timer !== undefined) clearTimeout(timer);
  releaseTimers.delete(path);
}

function scheduleRelease(path: string) {
  cancelRelease(path);
  const entry = cache.get(path);
  if (!entry?.url.startsWith("blob:")) return;
  const url = entry.url;
  releaseTimers.set(
    path,
    setTimeout(() => {
      releaseTimers.delete(path);
      if (mounted.has(path) || cache.get(path)?.url !== url) return;
      removeCached(path);
    }, 1_000),
  );
}

function evictIfFull(protectedPath?: string) {
  if (cache.size <= MAX_ENTRIES) return;
  for (const path of [...cache.keys()]) {
    if (cache.size <= MAX_ENTRIES) return;
    if (path === protectedPath || mounted.get(path)) continue;
    cancelRelease(path);
    removeCached(path);
  }
}

function cached(path: string): string | null {
  const entry = cache.get(path);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cancelRelease(path);
    removeCached(path);
    return null;
  }
  return entry.url;
}

export function primeChatImageUrl(path: string, url: string) {
  if (!path || !url) return;
  if (cache.has(path)) return;
  cache.set(path, { url, expiresAt: Number.POSITIVE_INFINITY });
  evictIfFull(path);
}

function resolve(path: string): Promise<string | null> {
  const pending = inflight.get(path);
  if (pending) return pending;
  const request = (async () => {
    try {
      const res = await apiFetch(
        `/api/chat/image-url?path=${encodeURIComponent(path)}`,
      );
      if (!res.ok) return null;
      const data = (await res.json()) as { signed_url?: string };
      if (!data.signed_url) return null;
      cache.set(path, { url: data.signed_url, expiresAt: Date.now() + TTL_MS });
      evictIfFull();
      return data.signed_url;
    } catch {
      return null;
    } finally {
      inflight.delete(path);
    }
  })();
  inflight.set(path, request);
  return request;
}

function ImageLightbox({ url, onClose }: { url: string; onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useModalFocusTrap(dialogRef, onClose, false, closeRef);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    const bodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = bodyOverflow;
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      tabIndex={-1}
      aria-modal="true"
      aria-label="Image preview"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className="fixed inset-0 z-[300] flex items-center justify-center bg-black/85 p-6"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt="Chat attachment"
        className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain shadow-2xl"
      />
      <button
        ref={closeRef}
        type="button"
        onClick={onClose}
        aria-label="Close image preview"
        className="absolute right-4 top-4 inline-flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white outline-none transition-colors hover:bg-white/20 focus-visible:ring-2 focus-visible:ring-white/70 motion-reduce:transition-none"
      >
        <X className="h-5 w-5" aria-hidden />
      </button>
    </div>,
    document.body,
  );
}

export function ChatImageThumb({
  path,
  className = "h-24 w-24 rounded-2xl",
  zoomable = true,
}: {
  path: string;
  className?: string;
  zoomable?: boolean;
}) {
  const [url, setUrl] = useState<string | null>(() => cached(path));
  const [error, setError] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const retriedRef = useRef(false);
  const closeZoom = useCallback(() => setZoomed(false), []);

  useEffect(() => {
    cancelRelease(path);
    mounted.set(path, (mounted.get(path) ?? 0) + 1);
    return () => {
      const next = (mounted.get(path) ?? 0) - 1;
      if (next > 0) mounted.set(path, next);
      else {
        mounted.delete(path);
        scheduleRelease(path);
      }
    };
  }, [path]);

  useEffect(() => {
    retriedRef.current = false;
    const hit = cached(path);
    if (hit) {
      setUrl(hit);
      setError(false);
      return;
    }
    let canceled = false;
    setUrl(null);
    setError(false);
    void resolve(path).then((next) => {
      if (canceled) return;
      if (next) setUrl(next);
      else setError(true);
    });
    return () => {
      canceled = true;
    };
  }, [path]);

  const onImageError = useCallback(() => {
    if (retriedRef.current) {
      setError(true);
      setUrl(null);
      return;
    }
    retriedRef.current = true;
    cancelRelease(path);
    removeCached(path);
    setUrl(null);
    void resolve(path).then((next) => {
      if (next) setUrl(next);
      else setError(true);
    });
  }, [path]);

  const box = `overflow-hidden border border-ink/10 ${className}`;

  if (url) {
    if (!zoomable) {
      return (
        <div className={`${box} block`}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={url}
            alt="Chat attachment"
            onError={onImageError}
            className="h-full w-full object-cover"
          />
        </div>
      );
    }
    return (
      <>
        <button
          type="button"
          onClick={() => setZoomed(true)}
          aria-label="Open image preview"
          className={`${box} group block cursor-zoom-in p-0 ${FOCUS_RING}`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={url}
            alt="Chat attachment"
            onError={onImageError}
            className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.03] motion-reduce:transition-none"
          />
        </button>
        {zoomed && <ImageLightbox url={url} onClose={closeZoom} />}
      </>
    );
  }

  if (error) {
    return (
      <div
        className={`${box} flex items-center justify-center bg-ink/5 px-2 text-center text-[11px] text-inkMuted`}
      >
        could not load image
      </div>
    );
  }

  return <div className={`${box} animate-pulse bg-ink/5`} />;
}
