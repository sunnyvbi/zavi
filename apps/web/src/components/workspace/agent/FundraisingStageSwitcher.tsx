"use client";

import { useCallback, useState } from "react";
import { apiFetch } from "@/lib/api";

export const STAGES = [
  "Angel",
  "Pre-seed",
  "Seed",
  "Series A",
  "Series B+",
] as const;

export type Stage = (typeof STAGES)[number];

export function isStage(v: unknown): v is Stage {
  return typeof v === "string" && (STAGES as readonly string[]).includes(v);
}

export function roundWithArticle(stage: Stage): string {
  return `${/^[aeiou]/i.test(stage) ? "an" : "a"} ${stage} round`;
}

async function persistStage(stage: Stage): Promise<boolean> {
  try {
    const res = await apiFetch("/api/fundraising/round-stage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function FundraisingStageSwitcher({
  stage,
  busy,
  onSwitched,
}: {
  stage: Stage | null;
  busy: boolean;
  onSwitched: (stage: Stage) => void;
}) {
  const [saving, setSaving] = useState<Stage | null>(null);
  const [failed, setFailed] = useState(false);

  const pick = useCallback(
    (next: Stage) => {
      if (busy || saving || next === stage) return;
      setFailed(false);
      setSaving(next);
      void (async () => {
        const ok = await persistStage(next);
        setSaving(null);
        if (!ok) {
          setFailed(true);
          return;
        }
        onSwitched(next);
      })();
    },
    [busy, saving, stage, onSwitched],
  );

  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
      <span className="text-[16px] font-medium text-inkMuted">Raising</span>

      <div
        role="radiogroup"
        aria-label="Which round are you raising?"
        className="inline-flex max-w-full gap-0.5 overflow-x-auto whitespace-nowrap rounded-full border border-rule bg-creamDeep p-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {STAGES.map((s) => {
          const active = s === stage;
          return (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={busy || saving !== null}
              onClick={() => pick(s)}
              className={
                active
                  ? "shrink-0 cursor-pointer rounded-full bg-ink px-3.5 py-1 text-[13px] font-semibold text-cream shadow-sm disabled:cursor-not-allowed disabled:opacity-60"
                  : "shrink-0 cursor-pointer rounded-full px-3.5 py-1 text-[13px] font-medium text-inkMuted transition-colors hover:bg-cream hover:text-ink disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
              }
            >
              {saving === s ? `${s}…` : s}
            </button>
          );
        })}
      </div>

      {}
      <span className={`text-[13px] ${failed ? "text-red-600" : "text-inkMuted"}`}>
        {failed
          ? "Couldn't save that round, so nothing was sourced. Try again."
          : stage === null
            ? "Pick one to rank and source for it."
            : "Switching re-sources and merges, never replaces."}
      </span>
    </div>
  );
}
