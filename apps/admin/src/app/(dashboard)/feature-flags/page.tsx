"use client";

import { useEffect, useState } from "react";
import { adminApiFetch } from "@/lib/api-admin";

type GlobalFlag = {
  key: string;
  value: unknown;
  value_type: string;
  description: string;
  updated_at: string | null;
  source: "app_setting" | "system_config";
};
type OverrideCount = { key: string; tenants: number };
type Resp = {
  globals: GlobalFlag[];
  overrides: OverrideCount[];
  summary: {
    globalFlags: number;
    appSettingFlags: number;
    blobFlags: number;
    overriddenKeys: number;
    tenantOverrides: number;
  };
};

function ValueCell({ v }: { v: unknown }) {
  if (typeof v === "boolean") {
    const c = v ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-600";
    return <span className={"inline-block rounded px-1.5 py-0.5 text-xs font-medium " + c}>{v ? "on" : "off"}</span>;
  }
  const text = typeof v === "string" ? v : JSON.stringify(v);
  return <span className="font-mono text-slate-900">{text}</span>;
}

export default function AdminFeatureFlagsPage() {
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await adminApiFetch("/api/admin/feature-flags");
        const r = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
        if (!cancelled) setData(r as Resp);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const overrideByKey = new Map<string, number>();
  for (const o of data?.overrides ?? []) overrideByKey.set(o.key, o.tenants);

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="mb-5">
        <div className="text-xs uppercase tracking-[0.2em] text-rose-700">Zavi · admin</div>
        <h1 className="font-display font-semibold text-2xl text-slate-900 mt-1">Feature flags</h1>
        <p className="text-sm text-slate-500 mt-1">
          Global flag values + how many tenants override each key. Read-only — this is a view, not a switch.
        </p>
      </div>

      {data && (
        <div className="flex gap-3 mb-4 flex-wrap">
          <Stat label="Global flags" value={data.summary.globalFlags} tone="slate" />
          <Stat label="Overridden keys" value={data.summary.overriddenKeys} tone="amber" />
          <Stat label="Tenant overrides" value={data.summary.tenantOverrides} tone="slate" />
        </div>
      )}

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 mb-4">{error}</div>
      )}

      {!data ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : (
        <>
          {}
          {data.globals.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-sm text-slate-600 text-center mb-6">
              No global flags.
            </div>
          ) : (
            <div className="rounded-xl border border-slate-200 bg-white overflow-hidden mb-6">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-[0.1em]">
                  <tr>
                    <th className="text-left px-3 py-2.5">Key</th>
                    <th className="text-left px-3 py-2.5">Value</th>
                    <th className="text-right px-3 py-2.5">Overrides</th>
                    <th className="text-left px-3 py-2.5">Source</th>
                    <th className="text-left px-3 py-2.5">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {data.globals.map((g, i) => (
                    <tr key={`${g.key}::${i}`} className="border-t border-slate-100 hover:bg-slate-50 align-top">
                      <td className="px-3 py-2 font-mono text-slate-900">
                        {g.key}
                        {g.description && (
                          <div className="text-sm text-slate-500 font-sans mt-0.5">{g.description}</div>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <ValueCell v={g.value} />
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-slate-600">
                        {overrideByKey.get(g.key) ?? 0}
                      </td>
                      <td className="px-3 py-2 text-slate-500 text-sm">{g.source.replace("_", " ")}</td>
                      <td className="px-3 py-2 font-mono text-slate-500 text-sm">
                        {g.updated_at ? new Date(g.updated_at).toLocaleString() : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {}
          <h2 className="font-display font-semibold text-base text-slate-900 mb-2">Per-tenant overrides</h2>
          {data.overrides.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-600 text-center">
              No tenant overrides — every tenant inherits the global value.
            </div>
          ) : (
            <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-[0.1em]">
                  <tr>
                    <th className="text-left px-3 py-2.5">Key</th>
                    <th className="text-right px-3 py-2.5">Tenants overriding</th>
                  </tr>
                </thead>
                <tbody>
                  {data.overrides.map((o, i) => (
                    <tr key={`${o.key}::${i}`} className="border-t border-slate-100 hover:bg-slate-50">
                      <td className="px-3 py-2 font-mono text-slate-900">{o.key}</td>
                      <td className="px-3 py-2 text-right font-mono text-slate-700">{o.tenants}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: "slate" | "amber" | "rose" }) {
  const c = tone === "rose" ? "text-rose-700" : tone === "amber" ? "text-amber-700" : "text-slate-900";
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 min-w-[110px]">
      <div className="text-xs uppercase tracking-[0.14em] text-slate-500">{label}</div>
      <div className={"font-display font-semibold text-xl mt-0.5 " + c}>{value}</div>
    </div>
  );
}
