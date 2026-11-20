"use client";

import { useEffect, useRef, useState } from "react";
import { Ellipsis, ExternalLink } from "lucide-react";
import {
  fetchRunCredits,
  type RunCreditsEntry,
} from "@/lib/workspace/runCredits";
import { cx, FOCUS_RING } from "./layout/shared";

type Load =
  | { state: "loading" }
  | { state: "ready"; summary: RunCreditsEntry }
  | { state: "error" };

function duration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

type CreditCopy = { primary: string; detail?: string };

function creditCopy(summary: RunCreditsEntry): CreditCopy {
  if (summary.status === "pending") return { primary: "Settling…" };
  if (summary.status === "refunded") return { primary: "Not charged" };
  if (summary.status === "covered")
    return summary.covered
      ? { primary: "Free", detail: `Zavi covered ${summary.covered.toLocaleString("en-US")} credits` }
      : { primary: "Not charged" };
  if (summary.status === "none") return { primary: "None" };
  return { primary: `${summary.credits.toLocaleString("en-US")} ${summary.credits === 1 ? "credit" : "credits"}` };
}

export function RunMetaMenu({
  runIds,
  elapsedSeconds,
  previewHref,
}: {
  runIds: ReadonlyArray<string>;
  elapsedSeconds: number;
  previewHref?: string | null;
}) {
  const key = runIds.join(",");
  const [open, setOpen] = useState(false);
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoad({ state: "loading" });
    void fetchRunCredits(runIds)
      .then((summary) => {
        if (!cancelled) setLoad({ state: "ready", summary });
      })
      .catch(() => {
        if (!cancelled) setLoad({ state: "error" });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, open]);

  const credits: CreditCopy =
    load.state === "ready"
      ? creditCopy(load.summary)
      : { primary: load.state === "error" ? "Unavailable" : "Loading…" };

  return (
    <div ref={rootRef} className={cx("relative", open && "z-40")}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label="More options"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="More"
        className={cx(
          "inline-flex h-8 w-8 items-center justify-center rounded-full text-[#8a8a8a] transition-colors hover:bg-ink/[0.06] hover:text-ink",
          open && "bg-ink/[0.06] text-ink",
          FOCUS_RING,
        )}
      >
        <Ellipsis className="h-[16px] w-[16px]" strokeWidth={2} aria-hidden />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Run details"
          className="absolute bottom-[calc(100%+6px)] left-0 z-50 w-max min-w-[min(240px,calc(100vw-32px))] max-w-[min(280px,calc(100vw-32px))] overflow-hidden rounded-xl border border-rule bg-cream p-1.5 shadow-menu"
        >
          <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-6 gap-y-2 px-2.5 py-2 text-[13px] leading-5">
            <dt className="whitespace-nowrap text-inkMuted">Worked for</dt>
            <dd className="min-w-0 text-right font-medium tabular-nums text-ink">
              {duration(elapsedSeconds)}
            </dd>
            <dt className="whitespace-nowrap text-inkMuted">Credits</dt>
            <dd
              role="status"
              aria-live="polite"
              className="min-w-0 text-right font-medium tabular-nums text-ink"
            >
              <span className="block">{credits.primary}</span>
              {credits.detail && (
                <span className="mt-0.5 block text-[12px] font-normal leading-4 text-inkMuted">
                  {credits.detail}
                </span>
              )}
            </dd>
          </dl>
          {previewHref && (
            <div className="mt-1 border-t border-rule/70 pt-1">
              <a
                href={previewHref}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setOpen(false)}
                className={cx(
                  "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] font-medium text-ink transition-colors hover:bg-bone focus-visible:bg-bone",
                  FOCUS_RING,
                )}
              >
                <ExternalLink
                  className="h-3.5 w-3.5 shrink-0 text-inkMuted"
                  aria-hidden
                />
                Preview
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
