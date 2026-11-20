"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { btn } from "../dashboard-ui";
import { money, type GadsPacing } from "./types";

export function MonthlyPlan({
  p,
  onSaved,
  slug = "google_ads",
}: {
  p: GadsPacing;
  onSaved: () => void;
  slug?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(p.plan ? String(Math.round(p.plan)) : "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async (usd: number | null) => {
    setBusy(true);
    setErr(null);
    try {
      const res = await apiFetch(`/api/channels/${slug}/monthly-budget`, { method: "PUT", body: JSON.stringify({ usd }) });
      const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      if (!res.ok) throw new Error(body.error?.message ?? `HTTP ${res.status}`);
      setEditing(false);
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const caps =
    p.capped_campaigns !== null && p.campaigns !== null && p.campaigns > 0
      ? ` · ${p.capped_campaigns} of ${p.campaigns} campaigns spent their full daily budget on most days`
      : "";

  return (
    <div data-testid="monthly-plan" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-inkMuted">
      <span>{p.plan === null ? "No plan yet: set one or add daily budgets" : `${money(p.spend)} of ${money(p.plan)} this month${caps}`}</span>
      {editing ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const n = Number(draft.replace(/[$,\s]/g, ""));
            if (!Number.isFinite(n) || n < 0) {
              setErr("Enter a monthly amount in dollars.");
              return;
            }
            void save(n);
          }}
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            inputMode="decimal"
            aria-label="Monthly plan in dollars"
            className="w-28 rounded-lg border border-rule bg-cream px-2 py-1 text-[16px] text-ink"
          />
          <button type="submit" disabled={busy} className={btn.primary}>
            {busy ? "…" : "Save"}
          </button>
          {p.plan_basis === "founder" && (
            <button type="button" disabled={busy} onClick={() => void save(null)} className={btn.secondary}>
              Use daily budgets
            </button>
          )}
        </form>
      ) : (
        <button type="button" onClick={() => setEditing(true)} className="font-medium text-inkSoft underline-offset-2 hover:underline">
          {p.plan_basis === "founder" ? "Your plan · Edit plan" : "Plan from your daily budgets · Edit plan"}
        </button>
      )}
      {err && (
        <p role="alert" className="w-full text-[13px] text-red-500">
          {err}
        </p>
      )}
    </div>
  );
}
