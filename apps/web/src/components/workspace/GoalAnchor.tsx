"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";

type Goal = {
  id: string;
  objective: string;
  target_metric: string;
  target_value: number | null;
  current_value: number | null;
  due_date: string | null;
  status: string;
};

function dueLabel(due: string | null): string | null {
  if (!due) return null;
  const ms = new Date(due).getTime() - Date.now();
  if (Number.isNaN(ms)) return null;
  const days = Math.ceil(ms / 86_400_000);
  if (days < 0) return "overdue";
  if (days === 0) return "due today";
  if (days === 1) return "1 day left";
  return `${days} days left`;
}

export function GoalAnchor() {
  const [goal, setGoal] = useState<Goal | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await apiFetch("/api/workspace/autopilot/goals");
        if (!res.ok) return;
        const json = (await res.json().catch(() => null)) as
          | { enabled?: boolean; goals?: Goal[] }
          | null;
        if (cancelled) return;
        if (!json?.enabled) {
          setGoal(null);
          return;
        }
        const active = (json.goals ?? []).find((g) => g.status === "active");
        setGoal(active ?? null);
      } catch {
      }
    }

    void load();

    const onChanged = () => void load();
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    window.addEventListener("autopilot:goals-changed", onChanged);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.removeEventListener("autopilot:goals-changed", onChanged);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  if (!goal) return null;

  const hasProgress =
    goal.target_value != null && goal.target_value > 0;
  const pct = hasProgress
    ? Math.min(
        100,
        Math.round(((goal.current_value ?? 0) / (goal.target_value as number)) * 100),
      )
    : null;
  const due = dueLabel(goal.due_date);

  return (
    <div className="mb-5 rounded-xl border border-ink/[0.08] bg-[#f7f2e9] px-4 py-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span aria-hidden className="text-[13px]">🎯</span>
        <span className="text-[13px] font-semibold text-ink">{goal.objective}</span>
        {hasProgress && (
          <span className="font-mono text-[12px] text-inkMuted">
            {goal.current_value ?? 0}/{goal.target_value}
          </span>
        )}
        {due && (
          <span className="font-mono text-[11px] text-inkMuted">· {due}</span>
        )}
      </div>
      {pct != null && (
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-ink/[0.08]">
          <div
            className="h-full rounded-full bg-emerald-500 transition-[width]"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
}
