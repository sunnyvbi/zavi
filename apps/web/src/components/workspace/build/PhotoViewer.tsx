"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronLeft, Download, FolderPlus, Info } from "lucide-react";
import type { FileRow } from "@/lib/workspace/useWorkspaceFiles";
import { cx, FOCUS_RING } from "../layout/shared";

export type PhotoZoom = "fit" | 1 | 2;

export const ZOOM_OPTIONS: Array<{ zoom: PhotoZoom; label: string }> = [
  { zoom: "fit", label: "Fit" },
  { zoom: 1, label: "100%" },
  { zoom: 2, label: "200%" },
];

export type PhotoDetail = { label: string; value: string };

const ICON_BUTTON = () => cx(
  "flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-inkMuted transition-colors hover:bg-bone hover:text-ink",
  FOCUS_RING,
);

const TOOLBAR_BUTTON = () => cx(
  "inline-flex h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-full px-3.5 text-[13px] font-medium text-ink transition-colors hover:bg-bone disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent",
  FOCUS_RING,
);

const POPOVER =
  "absolute z-30 rounded-2xl border border-rule bg-cream shadow-pop animate-code-fade motion-reduce:animate-none";

function typingInto(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

export function PhotoViewer({
  file,
  position,
  total,
  details,
  notice,
  moreMenu,
  onClose,
  onPrev,
  onNext,
  onAddToCollection,
}: {
  file: FileRow;
  position: number;
  total: number;
  details: PhotoDetail[];
  notice?: ReactNode;
  moreMenu: ReactNode;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  onAddToCollection: () => void;
}) {
  const [zoom, setZoom] = useState<PhotoZoom>("fit");
  const [zoomOpen, setZoomOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const backRef = useRef<HTMLButtonElement | null>(null);
  const infoWrapRef = useRef<HTMLDivElement | null>(null);
  const infoButtonRef = useRef<HTMLButtonElement | null>(null);
  const zoomWrapRef = useRef<HTMLDivElement | null>(null);
  const zoomButtonRef = useRef<HTMLButtonElement | null>(null);
  const zoomItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const infoId = useId();
  const zoomMenuId = useId();
  const titleId = useId();

  const handlers = useRef({ onClose, onPrev, onNext });
  handlers.current = { onClose, onPrev, onNext };
  const popovers = useRef({ infoOpen, zoomOpen });
  popovers.current = { infoOpen, zoomOpen };

  useEffect(() => {
    backRef.current?.focus();
  }, []);

  useEffect(() => {
    setZoom("fit");
    setZoomOpen(false);
    setNatural(null);
  }, [file.id]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape" && popovers.current.zoomOpen) {
        event.preventDefault();
        setZoomOpen(false);
        zoomButtonRef.current?.focus();
        return;
      }
      if (event.key === "Escape" && popovers.current.infoOpen) {
        event.preventDefault();
        setInfoOpen(false);
        infoButtonRef.current?.focus();
        return;
      }
      if (popovers.current.zoomOpen) return;
      if (document.querySelector('[role="menu"], [role="dialog"]')) return;
      if (typingInto(event.target)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        handlers.current.onClose();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        handlers.current.onPrev();
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        handlers.current.onNext();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!infoOpen && !zoomOpen) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (infoOpen && infoWrapRef.current && !infoWrapRef.current.contains(target)) setInfoOpen(false);
      if (zoomOpen && zoomWrapRef.current && !zoomWrapRef.current.contains(target)) setZoomOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [infoOpen, zoomOpen]);

  useEffect(() => {
    if (!zoomOpen) return;
    const at = ZOOM_OPTIONS.findIndex((o) => o.zoom === zoom);
    zoomItemRefs.current[at < 0 ? 0 : at]?.focus();
  }, [zoomOpen, zoom]);

  const zoomLabel = ZOOM_OPTIONS.find((o) => o.zoom === zoom)?.label ?? "Fit";
  const scaled =
    zoom !== "fit" && natural
      ? { width: natural.width * zoom, height: natural.height * zoom, maxWidth: "none", maxHeight: "none" }
      : undefined;
  const allDetails = natural
    ? [...details, { label: "Dimensions", value: `${natural.width} × ${natural.height}` }]
    : details;

  const pickZoom = (next: PhotoZoom) => {
    setZoom(next);
    setZoomOpen(false);
    zoomButtonRef.current?.focus();
  };

  return (
    <section
      aria-labelledby={titleId}
      data-testid="photo-viewer"
      className="absolute inset-0 z-[25] flex flex-col bg-cream animate-pane-fade motion-reduce:animate-none"
    >
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-rule px-3">
        <button ref={backRef} type="button" onClick={onClose} aria-label="Back to files" className={ICON_BUTTON()}>
          <ChevronLeft className="h-5 w-5" aria-hidden />
        </button>
        <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
          <ol className="flex min-w-0 items-center gap-1.5 text-[14px]">
            <li className="shrink-0">
              <button
                type="button"
                onClick={onClose}
                className={cx("rounded-cta px-1 font-medium text-inkMuted transition-colors hover:text-ink", FOCUS_RING)}
              >
                Files
              </button>
            </li>
            <li aria-hidden className="shrink-0 text-inkLight">
              /
            </li>
            <li className="min-w-0">
              <span id={titleId} aria-current="page" className="block truncate font-semibold text-ink">
                {file.name}
              </span>
            </li>
            <li className="relative shrink-0">
              <div ref={infoWrapRef}>
                <button
                  ref={infoButtonRef}
                  type="button"
                  onClick={() => setInfoOpen((open) => !open)}
                  aria-label="File details"
                  aria-expanded={infoOpen}
                  aria-controls={infoOpen ? infoId : undefined}
                  className={cx(ICON_BUTTON(), "h-7 w-7", infoOpen && "bg-bone text-ink")}
                >
                  <Info className="h-4 w-4" aria-hidden />
                </button>
                {infoOpen && (
                  <div
                    id={infoId}
                    role="group"
                    aria-label="File details"
                    className={cx(POPOVER, "left-0 top-full mt-2 w-[260px] p-4")}
                  >
                    <dl className="space-y-2.5 text-[13px]">
                      {allDetails.map((detail) => (
                        <div key={detail.label} className="flex items-start justify-between gap-3">
                          <dt className="shrink-0 text-inkMuted">{detail.label}</dt>
                          <dd className="min-w-0 break-words text-right font-medium text-ink">{detail.value}</dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                )}
              </div>
            </li>
          </ol>
        </nav>
        <span className="hidden shrink-0 text-[12px] tabular-nums text-inkMuted sm:block">
          {position} of {total}
        </span>
        {moreMenu}
        <a
          href={file.url}
          download={file.name}
          target="_blank"
          rel="noopener noreferrer"
          className={cx(
            "inline-flex h-9 shrink-0 items-center gap-2 rounded-full bg-ink px-4 text-[13px] font-medium text-cream transition-opacity hover:opacity-90",
            FOCUS_RING,
          )}
        >
          <Download className="h-4 w-4" aria-hidden />
          Download
        </a>
      </div>

      <div className="relative min-h-0 flex-1">
        <div className="pointer-events-none absolute inset-x-0 top-4 z-10 flex justify-center px-4">
          <div
            role="toolbar"
            aria-label="Photo actions"
            className="pointer-events-auto flex items-center gap-0.5 rounded-full border border-rule bg-cream p-1 shadow-pop"
          >
            <button type="button" onClick={onAddToCollection} className={TOOLBAR_BUTTON()}>
              <FolderPlus className="h-4 w-4 text-inkMuted" aria-hidden />
              Add to collections
            </button>
          </div>
        </div>

        <div data-testid="photo-stage" className="ws-scroll h-full w-full overflow-auto">
          <div
            className={cx(
              "flex min-h-full items-center justify-center px-6 pb-16 pt-20",
              zoom === "fit" ? "h-full w-full" : "w-max min-w-full",
            )}
          >
            <img
              key={file.id}
              src={file.url}
              alt={file.name}
              data-zoom={String(zoom)}
              decoding="async"
              onLoad={(event) => {
                const img = event.currentTarget;
                if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                  setNatural({ width: img.naturalWidth, height: img.naturalHeight });
                }
              }}
              style={scaled}
              className={cx(
                "block rounded-xl border border-rule bg-bone shadow-elevMd",
                zoom === "fit" ? "max-h-full max-w-full object-contain" : "max-w-none",
              )}
            />
          </div>
        </div>

        <div ref={zoomWrapRef} className="absolute bottom-4 right-4 z-10">
          <button
            ref={zoomButtonRef}
            type="button"
            onClick={() => setZoomOpen((open) => !open)}
            aria-label={`Zoom: ${zoomLabel}`}
            aria-haspopup="menu"
            aria-expanded={zoomOpen}
            aria-controls={zoomOpen ? zoomMenuId : undefined}
            className={cx(
              "inline-flex h-9 items-center gap-1.5 rounded-full border border-rule bg-cream pl-3.5 pr-2.5 text-[13px] font-medium text-ink shadow-elev transition-colors hover:bg-bone",
              FOCUS_RING,
            )}
          >
            {zoomLabel}
            <ChevronDown className="h-3.5 w-3.5 text-inkMuted" aria-hidden />
          </button>
          {zoomOpen && (
            <div
              id={zoomMenuId}
              role="menu"
              aria-label="Zoom"
              onKeyDown={(event) => {
                const items = zoomItemRefs.current.filter((el): el is HTMLButtonElement => !!el);
                const at = items.indexOf(document.activeElement as HTMLButtonElement);
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const step = event.key === "ArrowDown" ? 1 : -1;
                  items[(at + step + items.length) % items.length]?.focus();
                } else if (event.key === "Tab") {
                  setZoomOpen(false);
                }
              }}
              className={cx(POPOVER, "bottom-full right-0 mb-2 min-w-[132px] overflow-hidden rounded-xl p-1")}
            >
              {ZOOM_OPTIONS.map((option, index) => {
                const on = option.zoom === zoom;
                return (
                  <button
                    key={option.label}
                    ref={(el) => {
                      zoomItemRefs.current[index] = el;
                    }}
                    type="button"
                    role="menuitemradio"
                    aria-checked={on}
                    tabIndex={-1}
                    onClick={() => pickZoom(option.zoom)}
                    className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] text-ink transition-colors hover:bg-creamDeep focus:bg-creamDeep focus:outline-none"
                  >
                    <span className="flex w-4 shrink-0 justify-center">
                      {on && <Check className="h-3.5 w-3.5" aria-hidden />}
                    </span>
                    {option.label}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {notice && (
          <div className="pointer-events-none absolute inset-x-0 bottom-16 z-10 flex justify-center px-4">
            <div className="pointer-events-auto w-full max-w-[420px]">{notice}</div>
          </div>
        )}
      </div>
    </section>
  );
}
