"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Maximize2, X } from "lucide-react";
import { useModalFocusTrap } from "../../../layout/shared";

function MediaLightbox({ url, alt, video, onClose }: { url: string; alt: string; video: boolean; onClose: () => void }) {
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
  const fit = "max-h-[90vh] max-w-[90vw] rounded-lg object-contain shadow-2xl";
  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      tabIndex={-1}
      aria-modal="true"
      aria-label={video ? "Video preview" : "Image preview"}
      data-testid="media-lightbox"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className="fixed inset-0 z-[300] flex items-center justify-center bg-black/85 p-6"
    >
      {video
        ? <video src={url} controls autoPlay playsInline aria-label={alt || "Video"} className={`${fit} bg-black`} />
        // eslint-disable-next-line @next/next/no-img-element
        : <img src={url} alt={alt} className={fit} />}
      <button
        ref={closeRef}
        type="button"
        onClick={onClose}
        aria-label="Close preview"
        className="absolute right-4 top-4 inline-flex size-10 items-center justify-center rounded-full bg-white/10 text-white outline-none transition-colors hover:bg-white/20 focus-visible:ring-2 focus-visible:ring-white/70 motion-reduce:transition-none"
      >
        <X className="size-5" aria-hidden />
      </button>
    </div>,
    document.body,
  );
}

const CORNER = "absolute right-2 top-2 inline-flex size-8 items-center justify-center rounded-full bg-black/55 text-white opacity-0 transition-opacity duration-150 hover:bg-black/70 focus-visible:opacity-100 focus-visible:shadow-ca-focus focus-visible:outline-none group-hover/media:opacity-100 motion-reduce:transition-none [@media(hover:none)]:opacity-100";

export function MediaExpand({ url, alt, video = false, cover = false, className = CORNER, icon }: { url: string; alt: string; video?: boolean; cover?: boolean; className?: string; icon?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const expandRef = useRef<HTMLButtonElement>(null);
  const openFromCover = () => {
    expandRef.current?.focus();
    setOpen(true);
  };
  return (
    <>
      {cover && <span aria-hidden onClick={openFromCover} className="absolute inset-0 cursor-zoom-in" />}
      <button
        ref={expandRef}
        type="button"
        aria-label={video ? "Expand video" : "Expand image"}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className={className}
      >
        {icon ?? <Maximize2 className="size-4" aria-hidden />}
      </button>
      {open && <MediaLightbox url={url} alt={alt} video={video} onClose={() => setOpen(false)} />}
    </>
  );
}
