"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { adminApiFetch } from "@/lib/api-admin";

type AgentBreakdown = {
  agent_slug: string;
  runs: number;
  tokens: number;
  usd: number;
};

type TenantRow = {
  tenant_id: string;
  slug: string;
  display_name: string;
  runs: number;
  tokens: number;
  llm_usd: number;
  render_count: number;
  neon_count: number;
  infra_monthly_usd: number;
  infra_window_usd: number;
  total_window_usd: number;
  byAgent: AgentBreakdown[];
};

type Resp = {
  days: number;
  generated_at: string;
  pricing: { render_starter_usd_mo: number; neon_usd_mo: number };
  totals: {
    tenants: number;
    runs: number;
    tokens: number;
    llm_usd: number;
    infra_monthly_usd: number;
    infra_window_usd: number;
    total_window_usd: number;
  };
  tenants: TenantRow[];
};

export default function AdminTenantCostsPage() {
  return <Body />;
}

function Body() {
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(30);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    (async () => {
      try {
        const res = await adminApiFetch(`/api/admin/tenant-costs?days=${days}`);
        const r = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
        if (cancelled) return;
        setData(r as Resp);
      } catch (e) {
        if (cancelled) return;
        setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [days]);

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="flex items-center justify-between mb-5">
        <div>
          <div className="text-xs uppercase tracking-[0.2em] text-sky-700">
            Zavi · admin
          </div>
          <h1 className="font-display font-semibold text-2xl text-slate-900 mt-1">
            Tenant cost
          </h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Total cost to us per tenant — LLM compute + infra hosting.
          </p>
        </div>
        <select
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm"
        >
          <option value={7}>7d</option>
          <option value={30}>30d</option>
          <option value={90}>90d</option>
        </select>
      </div>

      <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 mb-4 leading-relaxed">
        <strong>Estimate, not a billing source of truth.</strong> LLM cost is summed
        from <code>agent_runs.cost_usd</code>, which is known to undercount Anthropic
        spend — treat totals as a floor. Infra is estimated at $
        {data?.pricing.render_starter_usd_mo ?? 7}/mo per ready Render service + $
        {data?.pricing.neon_usd_mo ?? 0}/mo per Neon DB, prorated to the window.
      </div>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 mb-4">
          {error}
        </div>
      )}

      {!data ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : (
        <>
          <div className="grid grid-cols-4 gap-3 mb-6">
            <Total
              label={`Total · ${data.days}d`}
              value={`$${data.totals.total_window_usd.toFixed(2)}`}
            />
            <Total label="LLM compute" value={`$${data.totals.llm_usd.toFixed(2)}`} />
            <Total
              label="Infra / mo"
              value={`$${data.totals.infra_monthly_usd.toFixed(2)}`}
            />
            <Total label="Tenants" value={data.totals.tenants.toLocaleString()} />
          </div>

          {data.tenants.length === 0 ? (
            <div className="glass-card border-dashed p-8 text-sm text-slate-600 text-center">
              No tenant cost in window.
            </div>
          ) : (
            <div className="glass-card overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-white/50 text-slate-600 text-xs uppercase tracking-[0.1em]">
                  <tr>
                    <th className="text-left px-3 py-2.5">Tenant</th>
                    <th className="text-right px-3 py-2.5">Runs</th>
                    <th className="text-right px-3 py-2.5">Tokens</th>
                    <th className="text-right px-3 py-2.5">LLM $</th>
                    <th className="text-right px-3 py-2.5">Infra $/mo</th>
                    <th className="text-right px-3 py-2.5">Total ({data.days}d)</th>
                  </tr>
                </thead>
                <tbody>
                  {data.tenants.map((t) => {
                    const open = expanded === t.tenant_id;
                    return (
                      <FragmentRow
                        key={t.tenant_id}
                        t={t}
                        open={open}
                        onToggle={() =>
                          setExpanded(open ? null : t.tenant_id)
                        }
                      />
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function FragmentRow({
  t,
  open,
  onToggle,
}: {
  t: TenantRow;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr
        className="border-t border-slate-100 hover:bg-slate-50 cursor-pointer"
        onClick={onToggle}
      >
        <td className="px-3 py-2">
          <div className="flex items-center gap-2">
            <span className="text-slate-400 w-3 inline-block">
              {open ? "▾" : "▸"}
            </span>
            <div>
              <div className="text-slate-900">{t.display_name}</div>
              <Link
                href={`/tenants/${t.tenant_id}`}
                onClick={(e) => e.stopPropagation()}
                className="text-xs text-slate-500 hover:underline"
              >
                {t.slug}
              </Link>
            </div>
          </div>
        </td>
        <td className="px-3 py-2 text-right font-mono text-slate-600">{t.runs}</td>
        <td className="px-3 py-2 text-right font-mono text-slate-600">
          {t.tokens.toLocaleString()}
        </td>
        <td className="px-3 py-2 text-right font-mono text-slate-700">
          ${t.llm_usd.toFixed(2)}
        </td>
        <td className="px-3 py-2 text-right font-mono text-slate-700">
          ${t.infra_monthly_usd.toFixed(2)}
          {(t.render_count > 0 || t.neon_count > 0) && (
            <span className="text-xs text-slate-400 ml-1">
              ({t.render_count}r/{t.neon_count}n)
            </span>
          )}
        </td>
        <td className="px-3 py-2 text-right font-mono font-semibold text-slate-900">
          ${t.total_window_usd.toFixed(2)}
        </td>
      </tr>
      {open && (
        <tr className="bg-slate-50/60">
          <td colSpan={6} className="px-3 py-2">
            {t.byAgent.length === 0 ? (
              <div className="text-sm text-slate-500 pl-5">
                No agent runs in window (infra-only cost).
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-slate-500 text-xs uppercase tracking-[0.1em]">
                  <tr>
                    <th className="text-left px-2 py-1 pl-5">Agent</th>
                    <th className="text-right px-2 py-1">Runs</th>
                    <th className="text-right px-2 py-1">Tokens</th>
                    <th className="text-right px-2 py-1">USD</th>
                  </tr>
                </thead>
                <tbody>
                  {t.byAgent.map((a) => (
                    <tr key={a.agent_slug}>
                      <td className="px-2 py-1 pl-5 text-slate-800">
                        {a.agent_slug}
                      </td>
                      <td className="px-2 py-1 text-right font-mono text-slate-600">
                        {a.runs}
                      </td>
                      <td className="px-2 py-1 text-right font-mono text-slate-600">
                        {a.tokens.toLocaleString()}
                      </td>
                      <td className="px-2 py-1 text-right font-mono text-slate-900">
                        ${a.usd.toFixed(3)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function Total({ label, value }: { label: string; value: string }) {
  return (
    <div className="glass-card p-4">
      <div className="text-sm uppercase tracking-[0.14em] text-slate-500">
        {label}
      </div>
      <div className="mt-1 font-display font-semibold text-2xl tabular-nums text-slate-900">
        {value}
      </div>
    </div>
  );
}
