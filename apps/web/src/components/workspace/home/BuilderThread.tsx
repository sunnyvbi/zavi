"use client";

import { type ChangedFile } from "./refineFiles";
import {
  type GateEvidenceView,
  type DeployStatusView,
  relativeTime,
  refineStatusBadge,
  buildStatusBadge,
  formatTurnMessage,
} from "./builderThreadFormat";
import { RefinePipelineCard } from "./RefinePipelineCard";

export { relativeTime, refineStatusBadge } from "./builderThreadFormat";

export type BuilderTurn =
  | {
      kind: "build";
      id: string;
      message: string;
      status: "building" | "live" | "failed";
      created_at: string;
    }
  | {
      kind: "refine";
      id: string;
      message: string;
      status: string;
      created_at: string;
      summary: string | null;
      pr_url: string | null;
      files?: ChangedFile[];
      gate_evidence?: GateEvidenceView | null;
      preview_url?: string | null;
      failure_message?: string | null;
      no_ship_reason?: string | null;
    };

type BuilderThreadProps = {
  turns: BuilderTurn[];
  loading: boolean;
  latestShippedRefineId: string | null;
  deployTargetRefineId?: string | null;
  onUndo?: (refineId: string) => void;
  onRetry?: (message: string) => void;
  undoingId?: string | null;
  runActive?: boolean;
  deploy?: DeployStatusView | null;
  fill?: boolean;
  inviteBuild?: boolean;
};

export function BuilderThread({
  turns,
  loading,
  latestShippedRefineId,
  deployTargetRefineId = null,
  onUndo,
  onRetry,
  undoingId = null,
  runActive = false,
  deploy = null,
  fill = false,
  inviteBuild = true,
}: BuilderThreadProps) {
  if (loading && turns.length === 0) {
    return (
      <div className="mb-3 text-[12px] text-inkMuted" aria-live="polite">
        Loading your builder conversation…
      </div>
    );
  }

  if (turns.length === 0) {
    if (!inviteBuild) return null;
    return (
      <div className="mb-3 rounded-lg border border-dashed border-[#e0e0e0] bg-[#f9f9f9] px-3.5 py-2.5 text-[12px] text-inkSoft">
        Describe the app you want below. Your conversation (the first build and every change after) shows up here.
      </div>
    );
  }

  return (
    <ol
      className={`space-y-2 overflow-y-auto pr-1 ${
        fill ? "max-h-96 lg:h-full lg:max-h-none" : "mb-3 max-h-96"
      }`}
      aria-label="Builder conversation"
    >
      {turns.map((t) => {
        if (t.kind === "refine") {
          const isUndoCandidate = t.id === latestShippedRefineId;
          const deployHere = t.id === deployTargetRefineId ? deploy : null;
          return (
            <li
              key={`refine-${t.id}`}
              data-turn-kind="refine"
              className="rounded-xl border border-[#ececec] bg-[#f9f9f9] px-3.5 py-3"
            >
              <RefinePipelineCard
                turn={{
                  id: t.id,
                  message: t.message,
                  status: t.status,
                  created_at: t.created_at,
                  summary: t.summary,
                  pr_url: t.pr_url,
                  files: t.files,
                  gate_evidence: t.gate_evidence,
                  preview_url: t.preview_url,
                  failure_message: t.failure_message ?? null,
                  no_ship_reason: t.no_ship_reason ?? null,
                }}
                isUndoable={isUndoCandidate}
                onUndo={onUndo}
                onRetry={onRetry}
                undoingId={undoingId}
                runActive={runActive}
                deploy={deployHere}
              />
            </li>
          );
        }

        const badge = buildStatusBadge(t.status);
        return (
          <li
            key={`build-${t.id}`}
            data-turn-kind="build"
            className="rounded-xl border border-[#e6e6e6] bg-[#f9f9f9] px-3.5 py-3"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <span className="mb-0.5 block text-[11px] font-semibold uppercase tracking-wide text-inkMuted">
                  First build
                </span>
                <p className="break-words text-[13px] leading-[1.5] text-ink">
                  {(() => {
                    const m = formatTurnMessage(t.message);
                    return (
                      <>
                        {m.text}
                        {m.planApplied && (
                          <span className="ml-1.5 inline-flex items-center rounded-full bg-ink/[0.06] px-1.5 py-[1px] align-middle text-[11px] font-medium text-inkMuted">
                            Plan applied
                          </span>
                        )}
                      </>
                    );
                  })()}
                </p>
              </div>
              <span
                className={`shrink-0 rounded-full px-2 py-[1px] text-[11px] font-medium ${badge.cls}`}
              >
                {badge.label}
              </span>
            </div>
            <div className="mt-1 flex items-center gap-2 text-[11px] text-inkMuted">
              <span>{relativeTime(t.created_at)}</span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
