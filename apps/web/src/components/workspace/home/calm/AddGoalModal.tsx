"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { parseGoal, goalCreateBody } from "./parseGoal";
import type { HomeGoal } from "./calmTypes";
import { NextChevron } from "@/components/ui/NextChevron";

const EXAMPLES = [
  "Grow verified hosts to 800 by September",
  "Cut host verification time to under 24h",
  "Get weekly signups to 500 by Q3",
];

export function AddGoalModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (goal: HomeGoal) => void;
}) {
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (open) {
      setText("");
      setError(null);
      setCreated(false);
      requestAnimationFrame(() => taRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const trimmed = text.trim();
  const parsed = useMemo(
    () => (trimmed.length >= 6 ? parseGoal(text) : null),
    [text, trimmed.length],
  );
  const missingTarget = parsed != null && parsed.target_value == null;
  const canSubmit = created || (trimmed.length >= 6 && !missingTarget && !submitting);

  if (!open) return null;

  async function submit() {
    if (!parsed || submitting) return;
    if (parsed.target_value == null) {
      setError('Add a number to your goal so your team can measure it, e.g. "to 500".');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch("/api/home/goals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(goalCreateBody(parsed)),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setError(body?.error?.message ?? `Couldn't save the goal (HTTP ${res.status}).`);
        setSubmitting(false);
        return;
      }
      const data = (await res.json().catch(() => ({}))) as {
        goal?: Partial<HomeGoal> & { id?: string };
        id?: string;
        warnings?: unknown;
      };
      const warnings = Array.isArray(data.warnings)
        ? data.warnings.filter((w): w is string => typeof w === "string" && w.length > 0)
        : [];
      const returned = data.goal ?? (data.id ? (data as Partial<HomeGoal>) : null);
      const goal: HomeGoal = {
        id: returned?.id ?? `optimistic-${Date.now()}`,
        objective: returned?.objective ?? parsed.objective,
        target_metric: returned?.target_metric ?? parsed.target_metric,
        target_value: returned?.target_value ?? parsed.target_value,
        baseline_value: returned?.baseline_value ?? parsed.baseline_value ?? null,
        current_value: returned?.current_value ?? null,
        due_date: returned?.due_date ?? parsed.due_date ?? null,
        status: returned?.status ?? "active",
        priority: returned?.priority ?? 0,
        source: returned?.source ?? "operator",
      };
      onCreated(goal);
      if (warnings.length > 0) {
        setCreated(true);
        setError(warnings.join(" "));
        return;
      }
      onClose();
    } catch (e) {
      setError((e as Error).message || "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <div
        aria-hidden
        onClick={onClose}
        className="fixed inset-0 z-[60] bg-ink/25"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Set a goal for your team"
        className="fixed left-1/2 top-1/2 z-[70] w-[480px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-ink/[0.12] bg-white shadow-[0_24px_60px_rgba(25,25,25,0.22)]"
      >
        <div className="px-4 pt-5">
          <h3 className="font-display text-[16px] font-semibold text-ink">
            Set a goal for your team
          </h3>
          <p className="mt-1.5 text-[13px] leading-[1.5] text-inkMuted">
            Say it in plain words. Your team turns it into a tracked goal and
            starts working toward it.
          </p>
        </div>

        <div className="px-4 pb-1 pt-4">
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={2}
            placeholder="e.g. Get weekly signups to 500 by end of Q3"
            className="w-full resize-none rounded-xl border border-ink/[0.12] px-3.5 py-3 text-[16px] text-ink outline-none transition-colors focus:border-ink/40 placeholder:text-inkMuted/70"
          />
          <div className="mt-2.5 flex flex-wrap gap-2">
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                type="button"
                onClick={() => {
                  setText(ex);
                  requestAnimationFrame(() => taRef.current?.focus());
                }}
                className="rounded-full border border-ink/[0.07] bg-cream px-2.5 py-1 text-[12px] text-inkMuted transition-colors hover:border-ink/25 hover:text-ink"
              >
                {ex}
              </button>
            ))}
          </div>

          {parsed && (
            <div className="mt-4 rounded-xl border border-dashed border-ink/[0.12] bg-cream p-3.5">
              <div className="font-mono text-[9.5px] uppercase tracking-[0.1em] text-inkMuted/70">
                Your team will track this as
              </div>
              <PreviewRow label="Goal" value={parsed.objective} strong />
              <PreviewRow
                label="Metric"
                value={parsed.target_metric || "-"}
                mono
              />
              <PreviewRow label="Target" value={parsed.targetLabel} mono />
              {missingTarget && (
                <div className="mt-2 text-[12px] text-inkMuted">
                  Add a number so your team can measure this, e.g. &ldquo;to
                  500&rdquo; or &ldquo;to 70%&rdquo;.
                </div>
              )}
              {parsed.baseline_value != null && (
                <PreviewRow
                  label="Starting from"
                  value={String(parsed.baseline_value)}
                  mono
                />
              )}
              {parsed.dueLabel && (
                <PreviewRow label="By" value={parsed.dueLabel} mono />
              )}
            </div>
          )}

          {error && (
            <div className="mt-3 rounded-lg border border-[#f4cfcb] bg-[#fdecec] px-3 py-2 text-[12px] text-[#a3372f]">
              {error}
            </div>
          )}
        </div>

        <div className="mt-3 flex justify-end gap-2.5 border-t border-ink/[0.08] px-4 py-3.5">
          <button
            type="button"
            onClick={onClose}
            className="rounded-cta px-3 py-1.5 text-[13px] font-medium text-inkMuted transition-colors hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => (created ? onClose() : void submit())}
            disabled={!canSubmit}
            className="rounded-cta bg-ink px-3.5 py-1.5 text-[13px] font-semibold text-cream transition-colors hover:bg-ink/85 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/40"
          >
            {submitting ? "Setting…" : created ? "Done" : <>Set goal <NextChevron /></>}
          </button>
        </div>
      </div>
    </>
  );
}

function PreviewRow({
  label,
  value,
  strong,
  mono,
}: {
  label: string;
  value: string;
  strong?: boolean;
  mono?: boolean;
}) {
  return (
    <div className="mt-2 flex items-center justify-between gap-3 text-[13px]">
      <span className="shrink-0 text-[12px] text-inkMuted">{label}</span>
      <span
        className={`min-w-0 truncate text-right ${strong ? "font-semibold text-ink" : "text-ink"} ${mono ? "font-mono text-[12px]" : ""}`}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}
