"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { Check, Copy, X } from "lucide-react";
import { buildFixMessage, errorDetails, errorKey, pillLabel } from "./previewErrors";
import { usePreviewErrorGate } from "./previewErrorGate";
import { usePreviewErrors, type TrackedPreviewError } from "./usePreviewErrors";

export const FIX_NO_BUILD = "Start a build first, then Zavi can fix this error for you.";
export const FIX_BUILD_FAILED = "This build stopped before it finished. Start it again, then fix the error.";
export const FIX_BUSY = "Wait for the current change to finish.";
export const FIX_SEND_FAILED = "Couldn't send the fix to the chat. Try again.";

type Notice = { text: string; credit?: boolean };

function timeLabel(at: number): string {
  try {
    return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

function copyWithSelection(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  try {
    return typeof document.execCommand === "function" && document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    return copyWithSelection(text);
  }
  return copyWithSelection(text);
}

function ErrorRow({ error }: { error: TrackedPreviewError }) {
  const [open, setOpen] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const resetTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    },
    [],
  );
  const copy = async () => {
    const ok = await copyText(errorDetails(error));
    setCopyState(ok ? "copied" : "failed");
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setCopyState("idle"), 2000);
  };
  const copied = copyState === "copied";
  const copyLabel = copied ? "Copied" : copyState === "failed" ? "Couldn't copy" : "Copy";
  const details = errorDetails(error);
  return (
    <li className="border-b border-rule py-2 last:border-b-0">
      <div className="flex items-center justify-between gap-2 text-[11px] text-inkMuted">
        <span className="truncate">
          {error.page} · {timeLabel(error.seenAt)}
          {error.count > 1 ? ` · ${error.count} times` : ""}
        </span>
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={copyState === "idle" ? "Copy error" : copyLabel}
          title={copyLabel}
          className="inline-flex h-7 min-w-7 shrink-0 items-center justify-center gap-1 rounded-full px-1.5 text-[12px] font-medium text-ink transition-colors hover:bg-bone focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
        >
          {copied ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
          <span aria-live="polite" className={copyState === "failed" ? undefined : "sr-only"}>{copyLabel}</span>
        </button>
      </div>
      <p className="mt-1 break-words text-[13px] font-medium leading-5 text-ink">{error.message}</p>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="mt-1 text-[12px] font-medium text-inkSoft underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
      >
        {open ? "Hide details" : "Show details"}
      </button>
      {open && (
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-bone p-2 font-mono text-[11px] leading-4 text-inkSoft">
          {details}
        </pre>
      )}
    </li>
  );
}

export function PreviewErrorPill({
  frameRef,
  src,
  yieldTo = false,
  onLogOpenChange,
  onVisibleChange,
}: {
  frameRef: RefObject<HTMLIFrameElement | null>;
  src: string | null | undefined;
  yieldTo?: boolean;
  onLogOpenChange?: (open: boolean) => void;
  onVisibleChange?: (visible: boolean) => void;
}) {
  const errors = usePreviewErrors(frameRef, src);
  const gate = usePreviewErrorGate();
  const busy = gate?.busy === true;
  const lastBusy = useRef(busy);
  const quietSince = useRef(0);
  if (lastBusy.current !== busy) {
    if (!busy) quietSince.current = Date.now();
    lastBusy.current = busy;
  }
  const [dismissedAt, setDismissedAt] = useState(0);
  const [logOpen, setLogOpen] = useState(false);
  useEffect(() => {
    onLogOpenChange?.(logOpen);
  }, [logOpen, onLogOpenChange]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [fixing, setFixing] = useState(false);
  const fixingRef = useRef(false);

  useEffect(() => {
    if (!logOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setLogOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [logOpen]);

  const shown = errors.filter(
    (error) => (error.seenAt >= quietSince.current || error.kind === "compile") && error.seenAt > dismissedAt,
  );
  const visible = !busy && !yieldTo && shown.length > 0;
  useEffect(() => {
    onVisibleChange?.(visible);
  }, [visible, onVisibleChange]);
  useEffect(() => () => onVisibleChange?.(false), [onVisibleChange]);
  if (!visible) return null;

  const dismiss = () => {
    setDismissedAt(Date.now());
    setLogOpen(false);
    setNotice(null);
  };

  const fix = async () => {
    if (fixingRef.current) return;
    if (!gate || !gate.active) {
      setNotice({ text: FIX_NO_BUILD });
      return;
    }
    if (gate.failed) {
      setNotice({ text: FIX_BUILD_FAILED });
      return;
    }
    if (gate.busy) {
      setNotice({ text: FIX_BUSY });
      return;
    }
    fixingRef.current = true;
    setFixing(true);
    setNotice(null);
    try {
      const result = await gate.fix(buildFixMessage(shown));
      if (result.ok) {
        setDismissedAt(Date.now());
        setLogOpen(false);
      } else {
        setNotice({ text: result.message, credit: result.credit === true });
      }
    } catch {
      setNotice({ text: FIX_SEND_FAILED });
    } finally {
      fixingRef.current = false;
      setFixing(false);
    }
  };

  return (
    <div
      data-testid="preview-error-pill"
      className="flex w-max max-w-[calc(100vw-32px)] flex-col items-center gap-2"
    >
      {logOpen && (
        <div
          role="dialog"
          aria-label="Preview error log"
          className="max-h-[50vh] w-[360px] max-w-[calc(100vw-48px)] overflow-auto rounded-xl border border-rule bg-white px-3 py-1 text-left shadow-elev"
        >
          <ul>
            {shown.map((error) => (
              <ErrorRow key={errorKey(error)} error={error} />
            ))}
          </ul>
        </div>
      )}
      {notice && !logOpen && (
        <div
          role="status"
          className="flex w-[320px] max-w-[calc(100vw-48px)] items-center gap-2 rounded-xl border border-rule bg-white p-3 text-[12px] leading-[1.5] text-inkSoft shadow-elev"
        >
          <span className="min-w-0 flex-1">{notice.text}</span>
          {notice.credit && gate && (
            <button
              type="button"
              onClick={gate.openBilling}
              className="shrink-0 rounded-full border border-rule px-3 py-1 text-[12px] font-medium text-ink transition-colors hover:bg-bone"
            >
              Buy credits
            </button>
          )}
        </div>
      )}
      <div
        role="toolbar"
        aria-label="Preview errors"
        className="inline-flex h-11 max-w-full items-center gap-1 rounded-full border border-rule bg-white p-1 shadow-pop"
      >
        <span aria-hidden className="ml-3 h-2 w-2 shrink-0 rounded-full bg-danger" />
        <span role="status" className="truncate whitespace-nowrap px-2 text-[14px] font-medium text-ink">
          {pillLabel(shown.length)}
        </span>
        <button
          type="button"
          onClick={() => {
            setLogOpen((v) => !v);
            setNotice(null);
          }}
          aria-expanded={logOpen}
          className="inline-flex h-9 shrink-0 items-center rounded-full border border-rule bg-white px-4 text-[13px] font-medium text-ink transition-colors hover:bg-bone focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
        >
          See log
        </button>
        <button
          type="button"
          onClick={() => void fix()}
          disabled={fixing}
          title={fixing ? FIX_BUSY : undefined}
          className="inline-flex h-9 shrink-0 items-center rounded-full bg-ink px-4 text-[13px] font-medium text-cream transition-colors hover:bg-ink/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30 disabled:opacity-50"
        >
          {fixing ? "Sending..." : "Fix error"}
        </button>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss preview errors"
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-ink transition-colors hover:bg-bone focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}
