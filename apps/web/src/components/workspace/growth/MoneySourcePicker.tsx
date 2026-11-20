"use client";

import { useEffect, useState } from "react";
import type { GrowthGoal } from "@/lib/workspace/useGrowthPlan";
import { apiFetch } from "@/lib/api";
import { formatGoalValue, isMoneyMetric } from "../AutopilotGoalsPanel";
import { errorMessageOf } from "../personalization/shared";
import { SecondaryButton } from "./GrowthSection";

export type MoneyCandidate = {
  source: "booking_value" | "stripe_gross_revenue";
  label: string;
  definition: string;
  value_30d_usd: number;
};

export const PICKED_LABEL: Record<string, string> = {
  booking_value: "Bookings database",
  stripe_gross_revenue: "Stripe",
};

export const COPY = {
  heading: "Where should Zavi measure this?",
  intro: "You have two sources for this number. Pick one and Zavi uses it from now on.",
  lastDays: "in the last 30 days",
  use: "Use this",
  measuredFrom: (label: string) => `Measured from ${label}.`,
  change: "Change source",
  saveFailed: "Could not save the source. Try again.",
};

function isCandidate(c: unknown): c is MoneyCandidate {
  const x = c as Partial<MoneyCandidate> | null;
  return !!x && (x.source === "booking_value" || x.source === "stripe_gross_revenue") && typeof x.label === "string" && typeof x.definition === "string" && typeof x.value_30d_usd === "number";
}

export async function readMoneyCandidates(metric: string): Promise<MoneyCandidate[] | null> {
  const res = await apiFetch(`/api/workspace/autopilot/goals/current-value?metric=${encodeURIComponent(metric)}`);
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as { candidates?: unknown } | null;
  const list = Array.isArray(body?.candidates) ? body.candidates.filter(isCandidate) : [];
  return list.length >= 2 ? list : null;
}

export function MoneySourcePicker({
  goal,
  canEdit,
  onChanged,
}: {
  goal: GrowthGoal;
  canEdit: boolean;
  onChanged: () => Promise<void>;
}) {
  const money = isMoneyMetric(goal.target_metric);
  const picked = goal.measurement_mode === "auto" ? goal.measure_source ?? null : null;
  const [open, setOpen] = useState(false);
  const [candidates, setCandidates] = useState<MoneyCandidate[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wanted = money && canEdit && (picked === null || open);
  useEffect(() => {
    if (!wanted) return;
    let cancelled = false;
    void readMoneyCandidates(goal.target_metric)
      .then((list) => {
        if (!cancelled) setCandidates(list);
      })
      .catch(() => {
        if (!cancelled) setCandidates(null);
      });
    return () => {
      cancelled = true;
    };
  }, [wanted, goal.target_metric]);

  if (!money) return null;

  const pick = async (source: MoneyCandidate["source"]) => {
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/workspace/autopilot/goals/${encodeURIComponent(goal.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ measure_source: source, measurement_mode: "auto" }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(errorMessageOf(body, COPY.saveFailed));
        return;
      }
      setOpen(false);
      await onChanged();
    } catch {
      setError(COPY.saveFailed);
    } finally {
      setSaving(false);
    }
  };

  if (picked !== null && !open) {
    return (
      <p className="mt-1.5 text-[13px] text-inkMuted">
        {COPY.measuredFrom(PICKED_LABEL[picked] ?? picked)}{" "}
        {canEdit && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="font-medium text-inkSoft underline underline-offset-2 hover:text-ink"
          >
            {COPY.change}
          </button>
        )}
      </p>
    );
  }
  if (!candidates) return null;

  return (
    <div className="mt-3 rounded-card border border-rule p-3" role="group" aria-label={COPY.heading}>
      <p className="text-[14px] font-medium text-ink">{COPY.heading}</p>
      <p className="mt-0.5 text-[13px] text-inkMuted">{COPY.intro}</p>
      <ul className="mt-2 space-y-2">
        {candidates.map((c) => (
          <li key={c.source} className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-medium text-ink">{c.label}</p>
              <p className="text-[13px] text-inkMuted">{c.definition}</p>
              <p className="text-[13px] tabular-nums text-ink">
                {formatGoalValue({ target_metric: goal.target_metric }, c.value_30d_usd)} {COPY.lastDays}
              </p>
            </div>
            <SecondaryButton onClick={() => void pick(c.source)} disabled={saving} label={`${COPY.use}: ${c.label}`}>
              {COPY.use}
            </SecondaryButton>
          </li>
        ))}
      </ul>
      {error && <p className="mt-2 text-[13px] text-danger">{error}</p>}
    </div>
  );
}
