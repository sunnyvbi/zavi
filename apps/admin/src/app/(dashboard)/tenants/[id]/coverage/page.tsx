"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { adminApiFetch } from "@/lib/api-admin";
import {
  TenantBackLink,
  TenantLabel,
  type TenantIdentity,
} from "@/components/admin/TenantIdentity";

type AgentCell = { slug: string; state: "handling" | "idle" | "hidden" | "not_present" };
type FnCoverage = {
  fn: string;
  agents: AgentCell[];
  agentHandling: number;
  applicableAgents: number;
  adminCovered: number;
  notApplicable: boolean;
  autonomyPct: number | null;
  uncovered: boolean;
};
type CoverageResp = {
  tenant_id: string;
  tenant: TenantIdentity;
  window_days: number;
  functions: FnCoverage[];
  note?: string;
};

const FN_LABEL: Record<string, string> = {
  acquisition: "Acquisition",
  activation: "Activation",
  retention: "Retention",
  revenue: "Revenue",
  referral: "Referral",
  ops: "Ops",
  support: "Support",
};

export default function CoverageMapPage() {
  const params = useParams();
  const tenantId = String(params?.id ?? "");
  const [data, setData] = useState<CoverageResp | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setError(null);
      try {
        const res = await adminApiFetch(`/api/admin/tenants/${tenantId}/coverage-map`);
        const r = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
        if (!cancelled) setData(r as CoverageResp);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  function statusChip(f: FnCoverage) {
    if (f.notApplicable)
      return <span className="rounded px-1.5 py-0.5 text-xs bg-slate-100 text-slate-500">n/a</span>;
    if (f.uncovered)
      return <span className="rounded px-1.5 py-0.5 text-xs bg-rose-50 text-rose-700">uncovered</span>;
    if (f.agentHandling > 0)
      return <span className="rounded px-1.5 py-0.5 text-xs bg-emerald-50 text-emerald-700">covered</span>;
    return <span className="rounded px-1.5 py-0.5 text-xs bg-amber-50 text-amber-700">admin only</span>;
  }

  return (
    <div className="max-w-5xl mx-auto p-6">
      <TenantBackLink tenantId={tenantId} tenant={data?.tenant ?? null} />
      <div className="mt-2 mb-5">
        <div className="text-xs uppercase tracking-[0.2em] text-sky-700">Zavi · admin</div>
        <h1 className="font-display font-semibold text-2xl text-slate-900 mt-1">Growth coverage</h1>
        <p className="text-sm text-slate-500 mt-1">
          <TenantLabel tenantId={tenantId} tenant={data?.tenant ?? null} /> · last {data?.window_days ?? 30}d ·
          is this company growing across all angles?
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 mb-4">{error}</div>
      )}

      {!data ? (
        <div className="text-sm text-slate-500">Loading coverage…</div>
      ) : (
        <div className="glass-card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-white/50 text-slate-600 text-xs uppercase tracking-[0.1em]">
              <tr>
                <th className="text-left px-3 py-2.5">Function</th>
                <th className="text-left px-3 py-2.5">Status</th>
                <th className="text-left px-3 py-2.5">Autonomy</th>
                <th className="text-left px-3 py-2.5">Agents handling</th>
                <th className="text-left px-3 py-2.5">Admin covers</th>
                <th className="text-left px-3 py-2.5">Mapped agents</th>
              </tr>
            </thead>
            <tbody>
              {data.functions.map((f) => (
                <tr key={f.fn} className="border-t border-slate-100">
                  <td className="px-3 py-2.5 font-medium text-slate-900">{FN_LABEL[f.fn] ?? f.fn}</td>
                  <td className="px-3 py-2.5">{statusChip(f)}</td>
                  <td className="px-3 py-2.5 font-mono text-slate-700">
                    {f.autonomyPct === null ? "—" : `${f.autonomyPct}%`}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-slate-600">
                    {f.agentHandling}/{f.applicableAgents}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-slate-600">{f.adminCovered}</td>
                  <td className="px-3 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {f.agents.map((a) => (
                        <span
                          key={a.slug}
                          title={a.state}
                          className={
                            "rounded px-1.5 py-0.5 text-xs " +
                            (a.state === "handling"
                              ? "bg-emerald-50 text-emerald-700"
                              : a.state === "idle"
                                ? "bg-amber-50 text-amber-700"
                                : "bg-slate-100 text-slate-400")
                          }
                        >
                          {a.slug}
                        </span>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data?.note && <p className="text-sm text-slate-400 mt-3">{data.note}</p>}
    </div>
  );
}
