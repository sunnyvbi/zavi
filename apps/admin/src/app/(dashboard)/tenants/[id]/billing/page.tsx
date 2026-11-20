"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { adminApiFetch } from "@/lib/api-admin";
import { CreditGrantPanel } from "@/components/admin/CreditGrantPanel";
import {
  TenantBackLink,
  TenantLabel,
  type TenantIdentity,
} from "@/components/admin/TenantIdentity";

type CreditsResp = {
  tenant: TenantIdentity;
  credit_usd: number;
  enforced: boolean;
  subscription: {
    plan: string;
    status: string | null;
    grandfathered: boolean;
    monthly_credits: number | null;
    stripe_customer_id: string | null;
    stripe_subscription_id: string | null;
    current_period_end: string | null;
    cancel_at_period_end: boolean | null;
    credits_revoked_at: string | null;
    tier: string | null;
    comp_expires_at: string | null;
  };
  balance: {
    period_start: string;
    period_end: string;
    included_allowance: number;
    included_used: number;
    included_remaining: number;
    purchased_balance: number;
    reserved: number;
    effective_available: number;
    effective_available_display: number;
    effective_available_usd: number;
    has_balance_row: boolean;
    updated_at: string | null;
  };
  usage_30d: {
    window_days: number;
    period_start: string;
    period_end: string;
    total_credits: number;
    total_usd: number;
    daily: { date: string; credits: number }[];
    by_agent: { agent_slug: string; credits: number }[];
  };
};

type LedgerRow = {
  id: string;
  run_id: string | null;
  kind: string;
  amount: number;
  source: string;
  agent_slug: string | null;
  cost_usd: number | null;
  period_start: string;
  stripe_payment_intent_id: string | null;
  created_at: string;
};

function fmtCredits(n: number): string {
  const neg = n < 0;
  const a = Math.abs(n);
  let s: string;
  if (a >= 1_000_000) s = `${(a / 1_000_000).toFixed(a % 1_000_000 === 0 ? 0 : 1)}M`;
  else if (a >= 1_000) s = `${(a / 1_000).toFixed(a % 1_000 === 0 ? 0 : 1)}K`;
  else s = `${a}`;
  return neg ? `-${s}` : s;
}
function fmtUsd(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function planLabel(plan: string): string {
  if (!plan) return "—";
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}
function fmtDate(d: string | null): string {
  if (!d) return "—";
  const t = Date.parse(d);
  if (Number.isNaN(t)) return d;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}
function fmtDateTime(d: string | null): string {
  if (!d) return "—";
  const t = Date.parse(d);
  if (Number.isNaN(t)) return d;
  return new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
}

const KIND_CLASS: Record<string, string> = {
  settle: "bg-sky-50 text-sky-700",
  reserve: "bg-slate-100 text-slate-500",
  refund: "bg-emerald-50 text-emerald-700",
  topup: "bg-violet-50 text-violet-700",
  grant: "bg-emerald-50 text-emerald-700",
};

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "rose" | "amber" }) {
  return (
    <div className="rounded-lg border border-slate-100 bg-white/60 px-3.5 py-3">
      <div className="text-xs uppercase tracking-[0.14em] text-slate-400">{label}</div>
      <div className={"mt-1 font-mono text-lg " + (tone === "rose" ? "text-rose-700" : tone === "amber" ? "text-amber-700" : "text-slate-900")}>
        {value}
      </div>
      {sub && <div className="text-xs text-slate-400 mt-0.5">{sub}</div>}
    </div>
  );
}

function BurnChart({ daily }: { daily: { date: string; credits: number }[] }) {
  const max = Math.max(1, ...daily.map((d) => d.credits));
  return (
    <div className="flex items-end gap-[3px] h-24">
      {daily.map((d) => (
        <div
          key={d.date}
          title={`${d.date}: ${d.credits.toLocaleString()} credits`}
          className="flex-1 rounded-t bg-sky-400/70 hover:bg-sky-500 transition-colors"
          style={{ height: `${Math.max(d.credits > 0 ? 4 : 0, (d.credits / max) * 96)}px` }}
        />
      ))}
    </div>
  );
}

export default function TenantBillingPage() {
  const params = useParams();
  const tenantId = String(params?.id ?? "");
  const [data, setData] = useState<CreditsResp | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [ledgerError, setLedgerError] = useState<string | null>(null);
  const [ledgerStarted, setLedgerStarted] = useState(false);

  const loadCredits = useCallback(async () => {
    setError(null);
    try {
      const res = await adminApiFetch(`/api/admin/tenants/${tenantId}/credits`);
      const r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
      setData(r as CreditsResp);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [tenantId]);

  useEffect(() => {
    if (tenantId) loadCredits();
  }, [tenantId, loadCredits]);

  const loadLedger = useCallback(
    async (before: string | null) => {
      setLedgerLoading(true);
      setLedgerError(null);
      try {
        const qs = before ? `?before=${encodeURIComponent(before)}` : "";
        const res = await adminApiFetch(`/api/admin/tenants/${tenantId}/credits/ledger${qs}`);
        const r = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
        setLedger((prev) => (before ? [...prev, ...(r.rows ?? [])] : r.rows ?? []));
        setNextBefore(r.next_before ?? null);
        setLedgerStarted(true);
      } catch (e) {
        setLedgerError((e as Error).message);
      } finally {
        setLedgerLoading(false);
      }
    },
    [tenantId],
  );

  useEffect(() => {
    if (tenantId) loadLedger(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  const sub = data?.subscription;
  const bal = data?.balance;
  const usage = data?.usage_30d;

  return (
    <div className="max-w-5xl mx-auto p-6">
      <div className="flex items-center gap-3">
        <TenantBackLink tenantId={tenantId} tenant={data?.tenant ?? null} />
      </div>
      <div className="mt-2 mb-5">
        <div className="text-xs uppercase tracking-[0.2em] text-sky-700">Zavi · admin</div>
        <h1 className="font-display font-semibold text-2xl text-slate-900 mt-1">Credits &amp; pricing</h1>
        <p className="text-sm text-slate-500 mt-1">
          <TenantLabel tenantId={tenantId} tenant={data?.tenant ?? null} /> · plan, wallet, 30-day usage &amp; full ledger.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 mb-4">{error}</div>
      )}

      {!data ? (
        <div className="text-sm text-slate-500">Loading credits…</div>
      ) : (
        <>
          {}
          <div className="glass-card p-4 mb-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded px-2 py-0.5 text-sm bg-slate-900 text-white">
                {planLabel(sub!.plan)}
              </span>
              <span className="rounded px-2 py-0.5 text-sm bg-sky-100 text-sky-800">
                {planLabel(sub!.tier ?? "free")} tier
              </span>
              {sub!.comp_expires_at && (
                <span className="rounded px-1.5 py-0.5 text-xs bg-emerald-50 text-emerald-700">
                  comped until {fmtDate(sub!.comp_expires_at)}
                </span>
              )}
              {sub!.status && (
                <span className="rounded px-1.5 py-0.5 text-xs bg-slate-100 text-slate-600">{sub!.status}</span>
              )}
              {sub!.grandfathered && (
                <span className="rounded px-1.5 py-0.5 text-xs bg-amber-50 text-amber-700">grandfathered</span>
              )}
              <span
                className={
                  "rounded px-1.5 py-0.5 text-xs " +
                  (data.enforced ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500")
                }
              >
                metering {data.enforced ? "enforced" : "off"}
              </span>
              {sub!.cancel_at_period_end && (
                <span className="rounded px-1.5 py-0.5 text-xs bg-rose-50 text-rose-700">cancels at period end</span>
              )}
              {sub!.credits_revoked_at && (
                <span className="rounded px-1.5 py-0.5 text-xs bg-rose-50 text-rose-700">
                  credits revoked {fmtDate(sub!.credits_revoked_at)}
                </span>
              )}
              {!bal!.has_balance_row && (
                <span className="rounded px-1.5 py-0.5 text-xs bg-slate-100 text-slate-500">no wallet row yet</span>
              )}
            </div>
            <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-sm text-slate-500 sm:grid-cols-3">
              <div>Period: <span className="font-mono text-slate-700">{fmtDate(bal!.period_start)} → {fmtDate(bal!.period_end)}</span></div>
              <div>Renews: <span className="font-mono text-slate-700">{fmtDate(sub!.current_period_end)}</span></div>
              <div>Ladder volume: <span className="font-mono text-slate-700">{sub!.monthly_credits != null ? fmtCredits(sub!.monthly_credits) : "—"}</span></div>
              <div>Stripe cust: <span className="font-mono text-slate-700">{sub!.stripe_customer_id ?? "—"}</span></div>
              <div>Stripe sub: <span className="font-mono text-slate-700">{sub!.stripe_subscription_id ?? "—"}</span></div>
              <div>Rate: <span className="font-mono text-slate-700">{fmtUsd(data.credit_usd)}/credit</span></div>
            </div>
          </div>

          {}
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6 mb-5">
            <Stat label="Allowance" value={fmtCredits(bal!.included_allowance)} sub="included / month" />
            <Stat label="Used" value={fmtCredits(bal!.included_used)} sub="this period" />
            <Stat label="Included left" value={fmtCredits(bal!.included_remaining)} />
            <Stat label="Purchased" value={fmtCredits(bal!.purchased_balance)} sub="non-expiring" tone={bal!.purchased_balance < 0 ? "rose" : undefined} />
            <Stat label="Reserved" value={fmtCredits(bal!.reserved)} sub="holds" tone={bal!.reserved > 0 ? "amber" : undefined} />
            <Stat
              label="Available"
              value={fmtCredits(bal!.effective_available)}
              sub={fmtUsd(bal!.effective_available_usd)}
              tone={bal!.effective_available < 0 ? "rose" : undefined}
            />
          </div>

          {}
          <h2 className="text-xs uppercase tracking-[0.16em] text-slate-500 mb-2">Plan</h2>
          <p className="text-sm text-slate-500 mb-3">
            Put this tenant on Starter, Growth or Pro for free for a set period. They get that plan&apos;s
            features and monthly credits; it drops back to Free when the period ends. Audited.
          </p>
          <div className="mb-6">
            <PlanCompPanel
              tenantId={tenantId}
              tier={sub!.tier}
              compExpiresAt={sub!.comp_expires_at}
              payingInStripe={!!sub!.stripe_subscription_id && !sub!.comp_expires_at && ["active", "trialing", "past_due"].includes(sub!.status ?? "")}
              onChanged={() => {
                loadCredits();
                loadLedger(null);
              }}
            />
          </div>

          {}
          <h2 className="text-xs uppercase tracking-[0.16em] text-slate-500 mb-2">Grant credits</h2>
          <p className="text-sm text-slate-500 mb-3">
            Promo/comp credits for this tenant. Lands in <span className="font-mono">purchased</span> (non-expiring).
            Capped, audited, idempotent, revocable.
          </p>
          <div className="mb-6">
            <CreditGrantPanel
              tenantId={tenantId}
              onGranted={() => {
                loadCredits();
                loadLedger(null);
              }}
            />
          </div>

          {}
          <div className="flex items-baseline justify-between">
            <h2 className="text-xs uppercase tracking-[0.16em] text-slate-500">
              Usage · last {usage!.window_days}d
            </h2>
            <div className="text-sm text-slate-500">
              {fmtCredits(usage!.total_credits)} credits · <span className="font-mono">{fmtUsd(usage!.total_usd)}</span>
            </div>
          </div>
          <div className="glass-card p-4 mt-2 mb-3">
            {usage!.total_credits === 0 ? (
              <div className="text-sm text-slate-400 py-6 text-center">No settled usage in the last {usage!.window_days} days.</div>
            ) : (
              <BurnChart daily={usage!.daily} />
            )}
            <div className="mt-1.5 flex justify-between text-xs font-mono text-slate-400">
              <span>{fmtDate(usage!.period_start)}</span>
              <span>{fmtDate(usage!.period_end)}</span>
            </div>
          </div>

          {usage!.by_agent.length > 0 && (
            <div className="glass-card overflow-hidden mb-6">
              <table className="w-full text-sm">
                <thead className="bg-white/50 text-slate-600 text-xs uppercase tracking-[0.1em]">
                  <tr>
                    <th className="text-left px-4 py-2.5">Agent</th>
                    <th className="text-right px-4 py-2.5">Credits 30d</th>
                    <th className="text-right px-4 py-2.5">≈ USD</th>
                    <th className="text-right px-4 py-2.5">Share</th>
                  </tr>
                </thead>
                <tbody>
                  {usage!.by_agent.map((a) => (
                    <tr key={a.agent_slug} className="border-t border-slate-100">
                      <td className="px-4 py-2 text-slate-900">{a.agent_slug}</td>
                      <td className="px-4 py-2 text-right font-mono">{a.credits.toLocaleString()}</td>
                      <td className="px-4 py-2 text-right font-mono text-slate-500">{fmtUsd(a.credits * data.credit_usd)}</td>
                      <td className="px-4 py-2 text-right font-mono text-slate-500">
                        {usage!.total_credits > 0 ? `${Math.round((a.credits / usage!.total_credits) * 100)}%` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {}
          <h2 className="text-xs uppercase tracking-[0.16em] text-slate-500 mb-2">Ledger history</h2>
          {ledgerError && (
            <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 mb-3">{ledgerError}</div>
          )}
          <div className="glass-card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-white/50 text-slate-600 text-xs uppercase tracking-[0.1em]">
                  <tr>
                    <th className="text-left px-3 py-2.5">When (UTC)</th>
                    <th className="text-left px-3 py-2.5">Kind</th>
                    <th className="text-right px-3 py-2.5">Amount</th>
                    <th className="text-left px-3 py-2.5">Source</th>
                    <th className="text-left px-3 py-2.5">Agent</th>
                    <th className="text-right px-3 py-2.5">Cost&nbsp;USD*</th>
                    <th className="text-left px-3 py-2.5">Run</th>
                  </tr>
                </thead>
                <tbody>
                  {ledger.length === 0 && ledgerStarted && !ledgerLoading && (
                    <tr>
                      <td colSpan={7} className="px-3 py-6 text-center text-sm text-slate-400">No ledger entries.</td>
                    </tr>
                  )}
                  {ledger.map((r) => (
                    <tr key={r.id} className="border-t border-slate-100">
                      <td className="px-3 py-2 font-mono text-slate-600 whitespace-nowrap">{fmtDateTime(r.created_at)}</td>
                      <td className="px-3 py-2">
                        <span className={"rounded px-1.5 py-0.5 text-xs " + (KIND_CLASS[r.kind] ?? "bg-slate-100 text-slate-500")}>
                          {r.kind}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right font-mono">{r.amount.toLocaleString()}</td>
                      <td className="px-3 py-2 text-slate-500">{r.source}</td>
                      <td className="px-3 py-2 text-slate-700">{r.agent_slug ?? "—"}</td>
                      <td className="px-3 py-2 text-right font-mono text-slate-500">
                        {r.cost_usd != null ? `$${Number(r.cost_usd).toFixed(4)}` : "—"}
                      </td>
                      <td className="px-3 py-2">
                        {r.run_id ? (
                          <a href={`/runs/${r.run_id}`} className="font-mono text-sm text-blue-700 hover:underline">
                            {r.run_id.slice(0, 8)}
                          </a>
                        ) : r.stripe_payment_intent_id ? (
                          <span className="text-sm text-slate-400">stripe</span>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between px-3 py-2 border-t border-slate-100">
              <span className="text-xs text-slate-400">
                cost_usd* is the raw compute floor — undercounts Anthropic spend ~15x.
              </span>
              {nextBefore ? (
                <button
                  onClick={() => loadLedger(nextBefore)}
                  disabled={ledgerLoading}
                  className="rounded-md border border-slate-200 bg-white px-3 py-1 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  {ledgerLoading ? "Loading…" : "Load more"}
                </button>
              ) : (
                <span className="text-xs text-slate-400">{ledgerLoading ? "Loading…" : "end of ledger"}</span>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function PlanCompPanel({
  tenantId,
  tier,
  compExpiresAt,
  payingInStripe,
  onChanged,
}: {
  tenantId: string;
  tier: string | null;
  compExpiresAt: string | null;
  payingInStripe: boolean;
  onChanged: () => void;
}) {
  const [nextTier, setNextTier] = useState<"starter" | "growth" | "pro">("starter");
  const [months, setMonths] = useState<1 | 3 | 6 | 12>(1);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(body: Record<string, unknown>) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await adminApiFetch(`/api/admin/tenants/${tenantId}/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
      setMsg({
        ok: true,
        text:
          r.tier === "free"
            ? "Back on Free."
            : `Now on ${planLabel(r.tier)} until ${fmtDate(r.comp_expires_at)}.`,
      });
      setReason("");
      onChanged();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  if (payingInStripe) {
    return (
      <div className="glass-card p-4 text-sm text-slate-600">
        This tenant pays for {planLabel(tier ?? "free")} through Stripe. Change their plan in Stripe, not here.
      </div>
    );
  }

  const reasonOk = reason.trim().length >= 3;
  return (
    <div className="glass-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={nextTier}
          onChange={(e) => setNextTier(e.target.value as "starter" | "growth" | "pro")}
          className="rounded-md border border-slate-300 px-2 py-1.5 text-sm bg-white"
        >
          <option value="starter">Starter</option>
          <option value="growth">Growth</option>
          <option value="pro">Pro</option>
        </select>
        <select
          value={months}
          onChange={(e) => setMonths(Number(e.target.value) as 1 | 3 | 6 | 12)}
          className="rounded-md border border-slate-300 px-2 py-1.5 text-sm bg-white"
        >
          {[1, 3, 6, 12].map((m) => (
            <option key={m} value={m}>
              {m} {m === 1 ? "month" : "months"}
            </option>
          ))}
        </select>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason (required)"
          className="flex-1 min-w-[200px] rounded-md border border-slate-300 px-2 py-1.5 text-sm"
        />
        <button
          type="button"
          disabled={busy || !reasonOk}
          onClick={() => submit({ tier: nextTier, months, reason: reason.trim() })}
          className="rounded-md bg-slate-900 px-3 py-1.5 text-sm text-white disabled:opacity-40"
        >
          {compExpiresAt ? "Replace comp" : "Give plan free"}
        </button>
        {compExpiresAt && (
          <button
            type="button"
            disabled={busy || !reasonOk}
            onClick={() => submit({ tier: "free", reason: reason.trim() })}
            className="rounded-md border border-rose-300 px-3 py-1.5 text-sm text-rose-700 disabled:opacity-40"
          >
            End comp now
          </button>
        )}
      </div>
      {msg && (
        <div className={`mt-2 text-sm ${msg.ok ? "text-emerald-700" : "text-rose-700"}`}>{msg.text}</div>
      )}
    </div>
  );
}
