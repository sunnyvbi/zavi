"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AdsDialog } from "@/components/ui/AdsDialog";
import { apiFetch } from "@/lib/api";
import { AD_BUDGET_URL } from "@/lib/workspace/tabUrl";

export type ModalMode = "pause" | "scale" | "edit";
export type RoasBand = "red" | "amber" | "green" | "gray";

export type BudgetModalCampaign = {
  campaign_id: string;
  channel: "meta" | "google";
  name: string;
  band: RoasBand;
  status_label: string;
  spend_label: string;
  roas_label: string;
  bookings_label: string;
  cost_label: string;
  pct_label: string;
  objective_label: string;
  current_daily_budget_usd: number | null;
  cost_per_result_usd: number | null;
};

const BAND_TEXT: Record<RoasBand, string> = {
  red: "text-[#b4232a]",
  amber: "text-[#8a6d00]",
  green: "text-[#176b43]",
  gray: "text-[#595959]",
};
const PILL_CLS: Record<RoasBand, string> = {
  red: "bg-[#fdebec] text-[#b4232a]",
  amber: "bg-[#fff5d9] text-[#8a6d00]",
  green: "bg-[#eaf6ef] text-[#176b43]",
  gray: "bg-[#f4f4f5] text-[#595959]",
};
const WHY_CLS: Record<RoasBand, string> = {
  red: "bg-[#fdebec] text-[#b4232a]",
  amber: "bg-[#fff5d9] text-[#8a6d00]",
  green: "bg-[#eaf6ef] text-[#176b43]",
  gray: "bg-[#f7f4ee] text-[#595959]",
};

function usd0(n: number): string {
  return `$${Math.round(n).toLocaleString()}`;
}

export const AD_BUDGET_LIMIT_MESSAGE =
  "Budget limit reached. Nothing was sent to your ad account. Raise your ad budget, or pick a smaller change.";

function mapDispatchError(reason: string | null): string | null {
  if (!reason) return null;
  const r = reason.toLowerCase();
  if (r.includes("drift")) {
    return "The budget changed in Meta since you opened this. Reopen the campaign and try again.";
  }
  if (r.includes("no_cap_configured")) {
    return "Meta rejected the change: no spend cap is configured for this ad account. Ask the agent in chat.";
  }
  if (r.includes("ad_budget_over_")) {
    return AD_BUDGET_LIMIT_MESSAGE;
  }
  if (r.includes("cap_refuse")) {
    return "This change exceeds the spend cap configured for this ad account.";
  }
  if (r.includes("target_no_longer_single_adset") || r.includes("ambiguous")) {
    return "This campaign's ad-set setup changed (more than one ad set now). Ask the agent in chat to make the change.";
  }
  return `Meta rejected the change: ${reason}`;
}

function recommendationCopy(mode: ModalMode, band: RoasBand): string {
  if (mode === "scale") {
    return "This is working. Raising the budget captures more demand. The agent watches frequency and recommends a pull-back if ROAS drops below your target.";
  }
  if (mode === "pause") {
    return "Recommended. Below break-even with no recovery. It's been losing money. Pausing stops the spend. Reversible in one click; learning is kept.";
  }
  switch (band) {
    case "red":
      return "The agent would pause this. It's been below break-even. If you'd rather keep testing, lower the budget below.";
    case "amber":
      return "Borderline performer. The agent is watching it. Trim the budget to play it safe, or leave it for now.";
    case "green":
      return "This is working. Raising the budget captures more demand, and the agent watches frequency and pulls back if ROAS drops below target.";
    default:
      return "Not enough data yet. Keep changes small until there's more signal.";
  }
}

export function AdsManagerBudgetModal({
  mode,
  campaign,
  onClose,
  onDone,
}: {
  mode: ModalMode;
  campaign: BudgetModalCampaign;
  onClose: () => void;
  onDone: () => void;
}) {
  const base = campaign.current_daily_budget_usd ?? 0;
  const startBudget =
    mode === "scale" ? Math.round(base * 1.5) : Math.round(base);
  const [budget, setBudget] = useState<number>(startBudget);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeBtnRef.current?.focus();
  }, []);

  const delta = budget - base;
  const monthlyNew = budget * 30;
  const impact = useMemo(() => {
    const md = delta * 30;
    if (delta === 0) return "Pick a new budget with the presets or type a number.";
    if (delta < 0)
      return `Frees ~${usd0(-md)}/mo to move into your winners.`;
    if (campaign.cost_per_result_usd && campaign.cost_per_result_usd > 0)
      return `Adds ~${usd0(md)}/mo · about ${Math.round(
        md / campaign.cost_per_result_usd,
      )} more results/mo at this campaign's current rate.`;
    return `Adds ~${usd0(md)}/mo. No conversions yet, so the return is unproven.`;
  }, [delta, campaign.cost_per_result_usd]);

  const canEditBudget = campaign.current_daily_budget_usd !== null;

  const pollDispatchOutcome = useCallback(
    async (
      decisionId: string,
    ): Promise<{ done: boolean; error?: string }> => {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        await new Promise((res) => setTimeout(res, 1000));
        try {
          const r = await apiFetch(
            `/api/agents/performance-marketer/budget-edit/status/${decisionId}`,
          );
          if (!r.ok) continue;
          const j = (await r.json().catch(() => null)) as {
            status?: string;
            dispatch_error?: string | null;
          } | null;
          if (!j?.status) continue;
          if (j.status === "rejected") {
            return {
              done: true,
              error:
                mapDispatchError(j.dispatch_error ?? null) ??
                "Meta rejected the change. Ask the agent in chat.",
            };
          }
          if (j.status === "acted") return { done: true };
        } catch {
        }
      }
      return { done: false };
    },
    [],
  );

  const confirmEdit = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      const stageRes = await apiFetch(
        "/api/agents/performance-marketer/budget-edit",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            channel: campaign.channel,
            campaign_id: campaign.campaign_id,
            campaign_name: campaign.name,
            proposed_daily_budget_usd: budget,
          }),
        },
      );
      const stageJson = (await stageRes.json().catch(() => null)) as
        | { ok?: boolean; decision_id?: string; error?: { message?: string } }
        | null;
      if (!stageRes.ok || !stageJson?.decision_id) {
        setError(
          stageJson?.error?.message ??
            "Couldn't stage this change. Ask the agent in chat instead.",
        );
        return;
      }
      const approveRes = await apiFetch(
        `/api/approvals/${stageJson.decision_id}/approve`,
        { method: "POST" },
      );
      if (!approveRes.ok) {
        setError(
          "The change was staged but couldn't be confirmed. Review it on the Growth page.",
        );
        return;
      }
      const outcome = await pollDispatchOutcome(stageJson.decision_id);
      if (outcome.error) {
        setError(outcome.error);
        return;
      }
      onDone();
      onClose();
    } catch {
      setError("Something went wrong. Try again, or ask the agent in chat.");
    } finally {
      setSubmitting(false);
    }
  }, [budget, campaign.campaign_id, campaign.channel, campaign.name, onClose, onDone, pollDispatchOutcome]);

  const confirmPause = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      const stageRes =
        campaign.channel === "google"
          ? await apiFetch("/api/agents/performance-marketer/campaign-status", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                channel: "google",
                campaign_id: campaign.campaign_id,
                campaign_name: campaign.name,
                enabled: false,
              }),
            })
          : await apiFetch("/api/agents/performance-marketer/pause", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ campaign_id: campaign.campaign_id }),
            });
      const stageJson = (await stageRes.json().catch(() => null)) as
        | { ok?: boolean; decision_id?: string; error?: { message?: string } }
        | null;
      if (!stageRes.ok || !stageJson?.decision_id) {
        setError(
          stageJson?.error?.message ??
            "Couldn't stage this pause. Ask the agent in chat instead.",
        );
        return;
      }
      const approveRes = await apiFetch(
        `/api/approvals/${stageJson.decision_id}/approve`,
        { method: "POST" },
      );
      if (!approveRes.ok) {
        setError(
          "The pause was staged but couldn't be confirmed. Review it on the Growth page.",
        );
        return;
      }
      const outcome = await pollDispatchOutcome(stageJson.decision_id);
      if (outcome.error) {
        setError(outcome.error);
        return;
      }
      onDone();
      onClose();
    } catch {
      setError("Something went wrong. Try again, or ask the agent in chat.");
    } finally {
      setSubmitting(false);
    }
  }, [campaign.campaign_id, campaign.channel, campaign.name, onClose, onDone, pollDispatchOutcome]);

  const titleLabel =
    mode === "pause"
      ? "Pause campaign"
      : mode === "scale"
        ? "Scale up budget"
        : "Edit budget";
  const confirmLabel =
    mode === "pause"
      ? "Pause campaign"
      : mode === "scale"
        ? "Confirm scale-up"
        : "Confirm change";
  const isPause = mode === "pause";
  const whyClass = isPause ? WHY_CLS.red : WHY_CLS[campaign.band];

  return (
    <AdsDialog
      size="md"
      label={`${titleLabel}: ${campaign.name}`}
      onClose={onClose}
      closeOnBackdrop
      chrome="rounded-[18px] bg-white shadow-[0_30px_90px_-20px_rgba(0,0,0,.5)]"
    >
        {}
        <div className="relative border-b border-[#e5e7eb] px-6 pb-4 pt-5">
          <button
            ref={closeBtnRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="absolute right-5 top-[18px] cursor-pointer border-0 bg-none text-[20px] leading-none text-[#a8a8a8] hover:text-[#595959]"
          >
            ×
          </button>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-[#8a8a8a]">
            {titleLabel}
          </div>
          <div className="mt-1 flex items-center text-[20px] font-bold tracking-[-.02em] text-[#0e0f11]">
            {campaign.name}
            <span
              className={`ml-2.5 rounded-md px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide ${PILL_CLS[campaign.band]}`}
            >
              {campaign.status_label}
            </span>
          </div>
          <div className="mt-0.5 text-[13px] text-[#595959]">
            {campaign.objective_label}
          </div>
        </div>

        {}
        <div className="px-6 pb-5 pt-[18px]">
          {}
          <div className="mb-4 flex overflow-hidden rounded-xl border border-[#e5e7eb]">
            <SnapCell k="Spent" v={campaign.spend_label} first />
            <SnapCell
              k="ROAS"
              v={campaign.roas_label}
              valueClass={BAND_TEXT[campaign.band]}
            />
            <SnapCell k="Bookings" v={campaign.bookings_label} />
            <SnapCell k="Cost / bk" v={campaign.cost_label} />
            <SnapCell k="% budget" v={campaign.pct_label} />
          </div>

          {}
          <div
            className={`mb-4 rounded-xl px-3.5 py-3 text-[16px] leading-[1.5] ${whyClass}`}
          >
            <span className="font-bold">
              {isPause ? "Recommended. " : ""}
            </span>
            {recommendationCopy(mode, campaign.band)}
          </div>

          {isPause ? (
            <PauseDetails baseDaily={base} />
          ) : !canEditBudget ? (
            <div className="rounded-xl border border-[#e5e7eb] bg-[#fbfaf7] px-4 py-3 text-[13px] text-[#595959]">
              This campaign doesn&apos;t have a single editable ad-set budget
              (it may use campaign budget optimization). Ask the agent in chat
              to change it.
            </div>
          ) : (
            <BudgetEditor
              base={base}
              budget={budget}
              setBudget={setBudget}
              delta={delta}
              monthlyNew={monthlyNew}
              impact={impact}
            />
          )}

          {error ? (
            <div className="mt-3 rounded-lg bg-[#fdebec] px-3 py-2 text-[13px] text-[#b4232a]">
              {error}
              {error === AD_BUDGET_LIMIT_MESSAGE && (
                <>
                  {" "}
                  <a href={AD_BUDGET_URL} data-testid="budget-modal-ad-budget" className="font-medium underline underline-offset-2">
                    Open ad budget settings
                  </a>
                </>
              )}
            </div>
          ) : null}

          <div className="mt-[15px] text-[13px] leading-[1.8] text-[#8a8a8a]">
            Changes apply going forward and are{" "}
            <span className="font-semibold text-[#595959]">
              reversible anytime
            </span>{" "}
            · the agent re-checks the live budget and your cost cap before
            applying.
          </div>
        </div>

        {}
        <div className="flex items-center justify-between gap-2.5 border-t border-[#e5e7eb] bg-[#fbfaf7] px-6 py-[15px]">
          <span className="text-[12px] text-[#8a8a8a]">
            Nothing changes until you confirm
          </span>
          <div className="flex gap-2.5">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="cursor-pointer rounded-xl border border-[#e5e7eb] bg-white px-[18px] py-2.5 text-[16px] font-semibold text-[#595959] transition-colors hover:bg-[#f7f4ee] disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={isPause ? confirmPause : confirmEdit}
              disabled={submitting || (!isPause && !canEditBudget)}
              className={`cursor-pointer rounded-xl border px-[18px] py-2.5 text-[16px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50 ${
                isPause
                  ? "border-[#b4232a] bg-[#b4232a]"
                  : mode === "scale"
                    ? "border-[#176b43] bg-[#176b43]"
                    : "border-[#0e0f11] bg-[#0e0f11]"
              }`}
            >
              {submitting ? "Confirming…" : confirmLabel}
            </button>
          </div>
        </div>
    </AdsDialog>
  );
}

function SnapCell({
  k,
  v,
  valueClass,
  first,
}: {
  k: string;
  v: string;
  valueClass?: string;
  first?: boolean;
}) {
  return (
    <div
      className={`flex-1 px-3.5 py-[11px] ${first ? "" : "border-l border-[#f0ede5]"}`}
    >
      <div className="text-[11px] font-semibold uppercase tracking-wide text-[#8a8a8a]">
        {k}
      </div>
      <div
        className={`mt-[3px] text-[14px] font-bold tabular-nums text-[#0e0f11] ${valueClass ?? ""}`}
      >
        {v}
      </div>
    </div>
  );
}

function PauseDetails({ baseDaily }: { baseDaily: number }) {
  return (
    <div className="rounded-xl border border-[#e5e7eb]">
      <Row k="What happens" v="All spend stops immediately" />
      <Row k="Frees up" v={`~${usd0(baseDaily * 30)}/mo`} />
      <Row k="Reversible" v="Reactivate in 1 click, learning kept" last />
    </div>
  );
}

function Row({ k, v, last }: { k: string; v: string; last?: boolean }) {
  return (
    <div
      className={`flex items-center justify-between px-3.5 py-[11px] text-[16px] ${last ? "" : "border-b border-[#f0ede5]"}`}
    >
      <span className="text-[#595959]">{k}</span>
      <span className="font-semibold text-[#1f1f1f]">{v}</span>
    </div>
  );
}

const PRESETS: { label: string; mult: number }[] = [
  { label: "−50%", mult: 0.5 },
  { label: "−25%", mult: 0.75 },
  { label: "Reset", mult: 1 },
  { label: "+25%", mult: 1.25 },
  { label: "+50%", mult: 1.5 },
];

function BudgetEditor({
  base,
  budget,
  setBudget,
  delta,
  monthlyNew,
  impact,
}: {
  base: number;
  budget: number;
  setBudget: (n: number) => void;
  delta: number;
  monthlyNew: number;
  impact: string;
}) {
  const pct = base > 0 ? Math.round((delta / base) * 100) : 0;
  const deltaText =
    delta === 0
      ? "No change yet"
      : delta > 0
        ? `+${usd0(delta)}/day (+${pct}%)`
        : `−${usd0(-delta)}/day (${pct}%)`;
  const deltaColor =
    delta > 0 ? "text-[#176b43]" : delta < 0 ? "text-[#b4232a]" : "text-[#8a8a8a]";

  return (
    <>
      <div className="rounded-2xl border border-[#e5e7eb] px-[18px] py-4">
        <div className="flex items-baseline justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-[#8a8a8a]">
            New daily budget
          </span>
          <span className="text-[13px] text-[#8a8a8a]">
            now {usd0(base)}/day · ~{usd0(base * 30)}/mo
          </span>
        </div>
        <div className="mt-1.5 flex items-baseline gap-[11px]">
          <span className="text-[14px] text-[#595959]">
            From <b className="tabular-nums">{usd0(base)}</b>
          </span>
          <span className="text-[20px] text-[#c8c8c8]">→</span>
          <span className="text-[32px] font-bold tracking-[-.025em] tabular-nums text-[#0e0f11]">
            {usd0(budget)}
          </span>
          <span className="text-[#8a8a8a]">/day</span>
          <span
            className={`ml-1.5 text-[13px] font-semibold tabular-nums ${deltaColor}`}
          >
            {deltaText}
          </span>
        </div>
        <div className="mt-[5px] text-[13px] text-[#8a8a8a]">
          ~{usd0(monthlyNew)}/mo
        </div>

        <div className="mt-[15px] flex flex-wrap items-center gap-[7px]">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => setBudget(Math.max(1, Math.round(base * p.mult)))}
              className="cursor-pointer rounded-[9px] border border-[#e5e7eb] bg-white px-3 py-[7px] text-[13px] font-semibold text-[#1f1f1f] hover:bg-[#f7f4ee]"
            >
              {p.label}
            </button>
          ))}
          <span className="ml-0.5 text-[13px] text-[#595959]">
            or $
            <input
              type="number"
              min={1}
              value={budget}
              onChange={(e) => {
                const n = Number(e.target.value);
                setBudget(Number.isFinite(n) && n > 0 ? Math.round(n) : 0);
              }}
              aria-label="Daily budget in dollars"
              className="w-[62px] rounded-lg border border-[#e5e7eb] px-2 py-1.5 text-[13px]"
            />
            /day
          </span>
        </div>
      </div>

      <div className="mt-3.5 flex gap-2.5 rounded-xl border border-[#e5e7eb] bg-[#fbfaf7] px-3.5 py-3 text-[13px] text-[#595959]">
        <span aria-hidden>📈</span>
        <span>{impact}</span>
      </div>
    </>
  );
}
