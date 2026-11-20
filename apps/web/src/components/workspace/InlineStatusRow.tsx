"use client";

import { useState } from "react";
import { useInlineStatus } from "@/lib/workspace/useInlineStatus";
import { apiFetch } from "@/lib/api";

export function InlineStatusRow({
  agentSlug,
  runId,
  onComplete,
  headless = false,
}: {
  agentSlug: string;
  runId: string;
  onComplete?: (
    status: "success" | "error" | "failed" | "cancelled",
    costUsd: number | null,
  ) => void;
  headless?: boolean;
}) {
  const status = useInlineStatus({ agentSlug, runId, onComplete });
  const [stopping, setStopping] = useState(false);

  async function onStop() {
    if (stopping) return;
    setStopping(true);
    try {
      await apiFetch(`/api/agents/runs/${encodeURIComponent(runId)}/cancel`, {
        method: "POST",
      });
    } catch {
      setStopping(false);
    }
  }

  if (status.phase === "done") {
    return (
      <div className="flex items-center gap-2 px-2.5 py-1.5 text-[13px] font-mono text-inkMuted">
        <span aria-hidden>✓</span>
        <span>completed in {status.elapsedSec}s</span>
        {status.costUsd != null && (
          <span className="text-inkMuted">· ${status.costUsd.toFixed(2)}</span>
        )}
      </div>
    );
  }
  if (status.phase === "error") {
    return (
      <div className="flex items-center gap-2 px-2.5 py-1.5 text-[13px] font-mono text-rose-700">
        <span aria-hidden>✗</span>
        <span>error after {status.elapsedSec}s</span>
      </div>
    );
  }
  if (status.phase === "cancelled") {
    return (
      <div className="flex items-center gap-2 px-2.5 py-1.5 text-[13px] font-mono text-inkMuted">
        <span aria-hidden>■</span>
        <span>stopped</span>
      </div>
    );
  }
  if (status.phase === "waiting") {
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex items-center gap-2 px-2.5 py-1.5 text-[13px] font-mono text-amber-700"
      >
        <span aria-hidden>⏸</span>
        {}
        <span>{status.detail || "waiting for your approval"}</span>
      </div>
    );
  }

  if (headless) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-2 px-2.5 py-1.5 text-[13px] font-mono text-ink"
    >
      <span
        aria-hidden
        className="inline-block h-2 w-2 animate-pulse rounded-full bg-inkMuted"
      />
      <span className="lowercase">↳ {status.detail}</span>
      <span className="text-inkMuted">· {status.elapsedSec}s</span>
      <button
        type="button"
        onClick={onStop}
        disabled={stopping}
        aria-label="Stop this run"
        className="ml-1 rounded border border-[#e5e7eb] px-1.5 py-0.5 text-[11px] text-inkMuted hover:text-ink hover:border-inkMuted disabled:opacity-60"
      >
        {stopping ? "stopping…" : "Stop"}
      </button>
    </div>
  );
}
