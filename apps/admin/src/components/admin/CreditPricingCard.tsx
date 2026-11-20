"use client";

import { useEffect, useMemo, useState } from "react";
import { adminApiFetch } from "@/lib/api-admin";

const USD_RUNGS = [
  50, 75, 100, 200, 300, 400, 500, 750, 1_000, 1_500, 2_000, 3_000, 4_000,
  5_000, 7_500, 10_000, 12_500, 15_000, 20_000, 25_000, 30_000,
];

const DEFAULT_CREDITS_PER_USD = 400;
const MIN_RATE = 1;
const MAX_RATE = 1_000_000;
const MAX_TIER = 2_000_000_000;

type Impact = {
  affected: number;
  increases: number;
  decreases: number;
  underwater: number;
  tenants: {
    tenant_id: string;
    slug: string | null;
    name: string | null;
    monthly_usd: number;
    used_this_period: number;
    current_allowance: number;
    new_allowance: number;
    delta: number;
    new_remaining: number;
    underwater: boolean;
  }[];
};

type ResyncRow = {
  tenant_id: string;
  previous_allowance: number;
  new_allowance: number;
  used_this_period: number;
};

function readRate(blob: Record<string, unknown>): number {
  const raw = blob.credits_per_usd;
  const n = typeof raw === "string" ? Number(raw.trim()) : typeof raw === "number" ? raw : NaN;
  if (!Number.isFinite(n)) return DEFAULT_CREDITS_PER_USD;
  const f = Math.floor(n);
  return f >= MIN_RATE && f <= MAX_RATE ? f : DEFAULT_CREDITS_PER_USD;
}

function readTiers(blob: Record<string, unknown>): Record<number, number> {
  const raw = blob.credit_tiers;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<number, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const usd = Number(k);
    const credits = typeof v === "string" ? Number(v.trim()) : typeof v === "number" ? v : NaN;
    if (!Number.isInteger(usd) || usd <= 0) continue;
    if (!Number.isFinite(credits) || credits < 0 || credits > MAX_TIER) continue;
    out[usd] = Math.floor(credits);
  }
  return out;
}

const nf = new Intl.NumberFormat("en-US");

export function CreditPricingCard({
  blob,
  onSaved,
}: {
  blob: Record<string, unknown>;
  onSaved: () => Promise<void>;
}) {
  const liveRate = readRate(blob);
  const liveTiers = readTiers(blob);

  const [rateDraft, setRateDraft] = useState(String(liveRate));
  const [rows, setRows] = useState<Record<number, string>>({});
  const [impact, setImpact] = useState<Impact | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState<ResyncRow[] | null>(null);
  const [confirmStrand, setConfirmStrand] = useState(false);

  useEffect(() => {
    const seeded: Record<number, string> = {};
    for (const usd of USD_RUNGS) {
      seeded[usd] = String(liveTiers[usd] ?? usd * liveRate);
    }
    setRateDraft(String(liveRate));
    setRows(seeded);
    setImpact(null);
    setConfirmStrand(false);
  }, [blob]); // eslint-disable-line react-hooks/exhaustive-deps

  const rate = Number(rateDraft.trim());
  const rateValid =
    Number.isFinite(rate) && Math.floor(rate) >= MIN_RATE && Math.floor(rate) <= MAX_RATE;
  const effRate = rateValid ? Math.floor(rate) : liveRate;

  const { tiers, rowsValid } = useMemo(() => {
    const t: Record<number, number> = {};
    let ok = true;
    for (const usd of USD_RUNGS) {
      const raw = (rows[usd] ?? "").trim();
      const n = Number(raw);
      if (raw === "" || !Number.isFinite(n) || n < 0 || n > MAX_TIER) {
        ok = false;
        continue;
      }
      const v = Math.floor(n);
      if (v !== usd * effRate) t[usd] = v;
    }
    return { tiers: t, rowsValid: ok };
  }, [rows, effRate]);

  const dirty =
    rateValid &&
    rowsValid &&
    (effRate !== liveRate || JSON.stringify(tiers) !== JSON.stringify(liveTiers));

  function creditsOf(usd: number): number {
    const raw = (rows[usd] ?? "").trim();
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : usd * effRate;
  }

  async function preview() {
    setPreviewing(true);
    setErr(null);
    try {
      const res = await adminApiFetch("/api/admin/credit-tiers/impact", {
        method: "POST",
        body: JSON.stringify({ credits_per_usd: effRate, credit_tiers: tiers }),
      });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
      setImpact(r as Impact);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setPreviewing(false);
    }
  }

  async function save() {
    if (!dirty || saving) return;
    if (impact && impact.underwater > 0 && !confirmStrand) {
      setConfirmStrand(true);
      return;
    }
    setSaving(true);
    setErr(null);
    setSaved(null);
    try {
      const res = await adminApiFetch("/api/admin/config", {
        method: "PATCH",
        body: JSON.stringify({ patch: { credits_per_usd: effRate, credit_tiers: tiers } }),
      });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
      if (r?.resync?.error) setErr(`Saved, but the wallet resync failed: ${r.resync.error}`);
      setSaved((r?.resync?.changed ?? []) as ResyncRow[]);
      setConfirmStrand(false);
      await onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mb-6 rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-display font-semibold text-slate-900">Credit pricing</h2>
        <span className="font-mono text-xs text-slate-400">credits_per_usd · credit_tiers</span>
      </div>
      <p className="mt-1 text-sm text-slate-500">
        What a dollar buys, for <span className="font-medium text-slate-700">every tenant</span>.
        Applies to the <span className="font-medium text-slate-700">current period</span>: each
        customer&apos;s allowance is recalculated immediately and credits they have already used are
        preserved. It never changes what anyone is charged — the ladder is priced in dollars.
      </p>

      {}
      <div className="mt-4 flex flex-wrap items-center gap-2 border-b border-slate-100 pb-4">
        <span className="text-sm font-medium text-slate-700">Base rate</span>
        <input
          type="number"
          min={MIN_RATE}
          max={MAX_RATE}
          value={rateDraft}
          onChange={(e) => {
            setRateDraft(e.target.value);
            setImpact(null);
            setConfirmStrand(false);
          }}
          className="w-32 rounded-md border border-slate-300 px-2 py-1 font-mono text-sm focus:border-skyMuted focus:outline-none focus:ring-1 focus:ring-skyMuted"
        />
        <span className="text-sm text-slate-500">
          credits per $1 — used by every tier without its own number
        </span>
      </div>
      {!rateValid && rateDraft.trim() !== "" && (
        <p className="mt-2 text-sm text-rose-700">
          Base rate must be a whole number between {MIN_RATE} and {nf.format(MAX_RATE)}.
        </p>
      )}

      {}
      <div className="mt-4 max-h-[22rem] overflow-y-auto rounded-md border border-slate-100">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500">
            <tr>
              <th className="px-3 py-2 font-medium">Tier</th>
              <th className="px-3 py-2 font-medium">Credits / mo</th>
              <th className="px-3 py-2 font-medium">Source</th>
            </tr>
          </thead>
          <tbody>
            {USD_RUNGS.map((usd) => {
              const isOverride = Object.prototype.hasOwnProperty.call(tiers, usd);
              const wasLive = liveTiers[usd] ?? liveRate * usd;
              const now = creditsOf(usd);
              return (
                <tr key={usd} className="border-t border-slate-100">
                  <td className="px-3 py-1.5 font-mono text-slate-500">${nf.format(usd)}</td>
                  <td className="px-3 py-1.5">
                    <input
                      type="number"
                      min={0}
                      max={MAX_TIER}
                      value={rows[usd] ?? ""}
                      onChange={(e) => {
                        setRows((r) => ({ ...r, [usd]: e.target.value }));
                        setImpact(null);
                        setConfirmStrand(false);
                      }}
                      className={`w-40 rounded-md border px-2 py-1 font-mono text-sm focus:outline-none focus:ring-1 focus:ring-skyMuted ${
                        isOverride ? "border-sky-300 bg-sky-50/50" : "border-slate-200"
                      }`}
                    />
                    {now !== wasLive && (
                      <span className="ml-2 font-mono text-xs text-slate-400">
                        was {nf.format(wasLive)}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-1.5">
                    {isOverride ? (
                      <span className="inline-flex items-center gap-2">
                        <span className="rounded bg-sky-100 px-1.5 py-0.5 text-xs font-medium text-sky-800">
                          override
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            setRows((r) => ({ ...r, [usd]: String(usd * effRate) }));
                            setImpact(null);
                          }}
                          className="text-xs font-medium text-slate-500 hover:text-slate-900"
                        >
                          reset
                        </button>
                      </span>
                    ) : (
                      <span className="text-xs text-slate-400">follows rate</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!rowsValid && (
        <p className="mt-2 text-sm text-rose-700">
          Every tier needs a whole number between 0 and {nf.format(MAX_TIER)}.
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={preview}
          disabled={previewing || !rateValid || !rowsValid}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
        >
          {previewing ? "Checking…" : "Preview impact"}
        </button>
        <button
          type="button"
          onClick={save}
          disabled={!dirty || saving}
          className={`rounded-md px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40 ${
            confirmStrand ? "bg-rose-600 hover:bg-rose-700" : "bg-slate-900 hover:bg-slate-800"
          }`}
        >
          {saving
            ? "Saving…"
            : confirmStrand
              ? `Yes — save and zero out ${impact?.underwater} customer(s)`
              : "Save pricing"}
        </button>
        {confirmStrand && (
          <button
            type="button"
            onClick={() => setConfirmStrand(false)}
            className="text-sm font-medium text-slate-600 hover:text-slate-900"
          >
            Cancel
          </button>
        )}
      </div>

      {err && <p className="mt-2 text-sm text-rose-700">{err}</p>}

      {}
      {impact && (
        <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3">
          <div className="text-sm text-slate-700">
            <span className="font-medium">{impact.affected}</span> customer(s) on a ladder tier ·{" "}
            <span className="text-emerald-700">{impact.increases} gain</span> ·{" "}
            <span className="text-amber-700">{impact.decreases} lose</span>
          </div>
          {impact.underwater > 0 && (
            <p className="mt-2 rounded border border-rose-200 bg-rose-50 p-2 text-sm text-rose-800">
              <span className="font-semibold">{impact.underwater} customer(s)</span> have already
              used more than their new tier. Saving leaves them with 0 credits for the rest of the
              period and their agent runs will start being rejected.
            </p>
          )}
          {impact.tenants.length > 0 && (
            <table className="mt-2 w-full text-xs">
              <thead className="text-left text-slate-500">
                <tr>
                  <th className="py-1 font-medium">Tenant</th>
                  <th className="py-1 font-medium">Tier</th>
                  <th className="py-1 font-medium">Used</th>
                  <th className="py-1 font-medium">Allowance</th>
                  <th className="py-1 font-medium">Left after</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {impact.tenants.map((t) => (
                  <tr key={t.tenant_id} className={t.underwater ? "text-rose-700" : "text-slate-700"}>
                    <td className="py-0.5">{t.slug ?? t.name ?? t.tenant_id.slice(0, 8)}</td>
                    <td className="py-0.5">${nf.format(t.monthly_usd)}</td>
                    <td className="py-0.5">{nf.format(t.used_this_period)}</td>
                    <td className="py-0.5">
                      {nf.format(t.current_allowance)} → {nf.format(t.new_allowance)}
                    </td>
                    <td className="py-0.5">{nf.format(Math.max(0, t.new_remaining))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {}
      {saved && (
        <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
          Saved.{" "}
          {saved.length === 0
            ? "No customer wallet changed."
            : `${saved.length} customer wallet(s) updated for the current period:`}
          {saved.length > 0 && (
            <ul className="mt-1 font-mono text-xs">
              {saved.map((r) => (
                <li key={r.tenant_id}>
                  {r.tenant_id.slice(0, 8)} · {nf.format(r.previous_allowance)} →{" "}
                  {nf.format(r.new_allowance)} allowance, {nf.format(r.used_this_period)} used →{" "}
                  {nf.format(Math.max(0, r.new_allowance - r.used_this_period))} left
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
