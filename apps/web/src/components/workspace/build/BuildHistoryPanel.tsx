"use client";

import { useEffect, useMemo, useRef } from "react";
import { History, Loader2, RotateCcw, XCircle } from "lucide-react";
import { useBuildSession, type BuildRefine, type BuildSessionRun } from "@/lib/workspace/useBuildSession";
import { apiFetch } from "@/lib/api";
import { cleanObjective, visibleRefines } from "./BuildModePane";
import { cx } from "../layout/shared";

type CheckpointState = "shipped" | "working" | "failed";

export type Checkpoint = {
  id: string;
  title: string;
  summary: string | null;
  at: string | null;
  state: CheckpointState;
  kind: "build" | "change" | "restore";
  live: boolean;
  awaitingReview: boolean;
  draft?: boolean;
  discarded?: boolean;
  previewUrl: string | null;
};

export type CheckpointView = { id: string; title: string; url: string | null; restorable: boolean; draft?: boolean; viewOnly?: boolean };

export function checkpointPreviewUrl(
  checkpoint: Checkpoint,
  liveUrl: string | null,
  currentId: string | null,
  draftId: string | null = null,
): string | null {
  if (draftId !== null) return checkpoint.id === draftId ? liveUrl : null;
  return currentId !== null && checkpoint.id === currentId ? liveUrl : null;
}

export function prewarmCheckpointId(
  checkpoints: Checkpoint[],
  liveUrl: string | null,
  currentId: string | null,
  draftId: string | null,
): string | null {
  return (
    checkpoints.find(
      (c) => c.state === "shipped" && c.discarded !== true && checkpointPreviewUrl(c, liveUrl, currentId, draftId) === null,
    )?.id ?? null
  );
}

const prewarmed = new Set<string>();

export function waitingDraftId(checkpoints: Checkpoint[]): string | null {
  return checkpoints.find((c) => c.draft === true && c.discarded !== true && c.state === "shipped")?.id ?? null;
}

const DONE = new Set(["done", "success", "succeeded", "skipped"]);
const FAILED = new Set(["failed", "halted", "cancelled", "canceled", "paused"]);

function stateOf(status: string): CheckpointState {
  if (DONE.has(status)) return "shipped";
  if (FAILED.has(status)) return "failed";
  return "working";
}

export function buildCheckpoints(run: BuildSessionRun | null, refines: BuildRefine[]): Checkpoint[] {
  const list: Checkpoint[] = [];
  if (run) {
    list.push({
      id: run.id,
      title: cleanObjective(run.objective ?? null) ?? "Initial build",
      summary: null,
      at: run.createdAt,
      state: stateOf(run.status),
      kind: "build",
      live: stateOf(run.status) === "shipped",
      awaitingReview: false,
      previewUrl: null,
    });
  }
  for (const refine of visibleRefines(refines)) {
    const state = stateOf(refine.status);
    list.push({
      id: refine.id,
      title: refine.message,
      summary: refine.discarded === true ? null : (refine.summary ?? refine.failure_message ?? null),
      at: refine.created_at,
      state,
      kind: refine.kind === "restore" || refine.kind === "undo" ? "restore" : "change",
      live:
        state === "shipped" &&
        refine.awaiting_review !== true &&
        refine.draft !== true &&
        refine.discarded !== true,
      awaitingReview: refine.awaiting_review === true,
      ...(refine.draft === true ? { draft: true } : {}),
      ...(refine.discarded === true ? { discarded: true } : {}),
      previewUrl: typeof refine.preview_url === "string" && /^https?:\/\//i.test(refine.preview_url) ? refine.preview_url : null,
    });
  }
  return list.sort((a, b) => (Date.parse(b.at ?? "") || 0) - (Date.parse(a.at ?? "") || 0));
}

export function formatStamp(iso: string | null): string {
  const at = iso ? new Date(iso) : null;
  if (!at || Number.isNaN(at.getTime())) return "";
  const date = at.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const time = at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `${date}, ${time}`;
}

export function BuildHistoryPanel({
  sessionId,
  liveUrl = null,
  selectedId = null,
  prewarm = false,
  onSelect,
  onClose,
}: {
  sessionId: string | null;
  liveUrl?: string | null;
  selectedId?: string | null;
  prewarm?: boolean;
  onSelect?: (view: CheckpointView) => void;
  onClose: () => void;
}) {
  const session = useBuildSession(sessionId, null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const checkpoints = useMemo(
    () => buildCheckpoints(session.run, session.refines),
    [session.run, session.refines],
  );
  const currentId =
    session.isCurrent === false || session.sitePublished === false ? null : (checkpoints.find((c) => c.live)?.id ?? null);
  const draftId = session.isCurrent === false ? null : waitingDraftId(checkpoints);
  const warmId = prewarm && session.loaded ? prewarmCheckpointId(checkpoints, liveUrl, currentId, draftId) : null;

  useEffect(() => {
    if (!warmId || prewarmed.has(warmId)) return;
    prewarmed.add(warmId);
    void apiFetch("/api/workspace/autopilot/version-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conductor_run_id: warmId, prewarm: true }),
    }).catch(() => undefined);
  }, [warmId]);

  useEffect(() => {
    headingRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <section
      aria-label="Build history"
      className="absolute inset-0 flex flex-col bg-cream animate-slide-in-left motion-reduce:animate-none"
    >
      <div className="ws-scroll min-h-0 flex-1 overflow-y-auto px-3 pb-5">
        <div className="sticky top-0 z-10 -mx-3 border-b border-rule bg-cream px-4 pb-2.5 pt-4">
          <h2
            ref={headingRef}
            tabIndex={-1}
            className="flex items-baseline gap-2 text-[14px] font-semibold text-ink focus:outline-none"
          >
            History
            {checkpoints.length > 0 && (
              <span className="text-[13px] font-normal tabular-nums text-inkMuted">{checkpoints.length}</span>
            )}
          </h2>
        </div>
        <div className="h-2" aria-hidden />
        {!sessionId || (session.loaded && checkpoints.length === 0) ? (
          <div className="flex flex-col items-center justify-center gap-3 px-6 py-24 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-bone">
              <History className="h-5 w-5 text-inkMuted" strokeWidth={1.75} aria-hidden />
            </span>
            <p className="text-[14px] font-semibold text-ink">No history yet</p>
            <p className="max-w-xs text-[13px] leading-5 text-inkMuted">Every change to your app is saved here.</p>
          </div>
        ) : !session.loaded ? (
          <div role="status" className="space-y-1">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center gap-6 rounded-xl px-3 py-3.5">
                <div
                  className="h-3 animate-pulse rounded-full bg-bone/80 motion-reduce:animate-none"
                  style={{ width: `${38 + ((i * 17) % 28)}%` }}
                />
                <div className="ml-auto h-2.5 w-20 shrink-0 animate-pulse rounded-full bg-bone/60 motion-reduce:animate-none" />
              </div>
            ))}
            <span className="sr-only">Loading history…</span>
          </div>
        ) : (
          <ol className="space-y-1">
            {checkpoints.map((checkpoint, index) => {
              const current = checkpoint.id === currentId;
              const url = checkpointPreviewUrl(checkpoint, liveUrl, currentId, draftId);
              const openable = checkpoint.state === "shipped";
              const selected = selectedId === checkpoint.id;
              return (
                <li
                  key={checkpoint.id}
                  aria-current={current ? "step" : undefined}
                  className="animate-tab-enter motion-reduce:animate-none"
                  style={{ animationDelay: `${Math.min(index, 8) * 25}ms` }}
                >
                  <button
                    type="button"
                    disabled={!openable}
                    aria-pressed={selected}
                    title={
                      !openable
                        ? "This change never finished, so there is no version to open"
                        : url
                          ? "Open the live app"
                          : "Open this version as it was"
                    }
                    onClick={() => {
                      if (openable) {
                        onSelect?.({
                          id: checkpoint.id,
                          title: checkpoint.title,
                          url,
                          restorable: !checkpoint.awaitingReview && checkpoint.draft !== true,
                          ...(checkpoint.draft ? { draft: true } : {}),
                        });
                      }
                    }}
                    className={cx(
                      "flex w-full min-w-0 items-center gap-3 rounded-cta border px-3 py-3 text-left transition-colors",
                      selected ? "border-ink/30 bg-bone" : "border-transparent hover:bg-bone/60",
                      !openable && "cursor-default opacity-60",
                    )}
                  >
                    {checkpoint.kind === "restore" && (
                      <RotateCcw className="h-3.5 w-3.5 shrink-0 text-inkMuted" aria-hidden />
                    )}
                    <span className={cx("min-w-0 flex-1 truncate text-[14px]", current || selected ? "font-medium text-ink" : "text-inkSoft")}>
                      {checkpoint.title}
                    </span>
                    {current && (
                      <span className="flex shrink-0 items-center gap-2 text-[12px] font-medium text-success">
                        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-success" />
                        Published
                      </span>
                    )}
                    {checkpoint.state === "shipped" && !checkpoint.live && (
                      <span className="shrink-0 text-[12px] text-inkMuted">
                        {checkpoint.discarded ? "Discarded" : "Not live yet"}
                      </span>
                    )}
                    {checkpoint.state === "working" && (
                      <span className="flex shrink-0 items-center gap-1 text-[12px] text-inkMuted">
                        <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden />
                        In progress
                      </span>
                    )}
                    {checkpoint.state === "failed" && (
                      <span className="flex shrink-0 items-center gap-1 text-[12px] text-danger">
                        <XCircle className="h-3.5 w-3.5" aria-hidden />
                        Stopped
                      </span>
                    )}
                    <time dateTime={checkpoint.at ?? undefined} className="shrink-0 text-[12px] tabular-nums text-inkMuted">
                      {formatStamp(checkpoint.at)}
                    </time>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </section>
  );
}
