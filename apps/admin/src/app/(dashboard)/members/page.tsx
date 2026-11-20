"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { adminApiFetch } from "@/lib/api-admin";

type Member = {
  email: string | null;
  name: string | null;
  role: string;
  status: "active" | "invited";
};
type TenantRow = {
  tenant_id: string;
  tenant: string;
  slug: string;
  tier: string | null;
  seats_used: number;
  seat_limit: number | null;
  members: Member[];
};
type Resp = { tenants: TenantRow[]; summary: { tenants: number; members: number; invited: number } };

const ROLE_BADGE: Record<string, string> = {
  owner: "bg-indigo-100 text-indigo-800",
  admin: "bg-sky-100 text-sky-800",
  member: "bg-slate-100 text-slate-600",
};

export default function AdminMembersPage() {
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await adminApiFetch("/api/admin/members");
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

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="mb-5">
        <div className="text-xs uppercase tracking-[0.2em] text-rose-700">Zavi · admin</div>
        <h1 className="font-display font-semibold text-2xl text-slate-900 mt-1">Seats & members</h1>
        <p className="text-sm text-slate-500 mt-1">
          Who's on each tenant, their role, and pending invites. Seat count is used vs cap per tier.
        </p>
      </div>

      {data && (
        <div className="flex gap-3 mb-4">
          <Stat label="Tenants" value={data.summary.tenants} />
          <Stat label="Active members" value={data.summary.members} />
          <Stat label="Pending invites" value={data.summary.invited} tone="amber" />
        </div>
      )}

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 mb-4">{error}</div>
      )}

      {!data ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : data.tenants.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-sm text-slate-600 text-center">
          No members.
        </div>
      ) : (
        <div className="space-y-4">
          {data.tenants.map((t) => (
            <div key={t.tenant_id} className="rounded-xl border border-slate-200 bg-white overflow-hidden">
              <div className="flex items-center justify-between gap-3 px-4 py-3 bg-slate-50 border-b border-slate-100">
                <div>
                  <Link href={`/tenants/${t.tenant_id}`} className="font-display font-semibold text-base text-slate-900 hover:underline">
                    {t.tenant}
                  </Link>
                  <span className="ml-2 text-sm text-slate-400">{t.slug}</span>
                </div>
                <div className="flex items-center gap-2">
                  {t.tier && (
                    <span className="inline-block rounded px-1.5 py-0.5 text-xs uppercase tracking-[0.08em] bg-slate-100 text-slate-500">
                      {t.tier}
                    </span>
                  )}
                  <span className="font-mono text-sm text-slate-600">
                    {t.seats_used}
                    {t.seat_limit != null ? ` / ${t.seat_limit}` : " / ∞"}
                    <span className="text-slate-400"> seats</span>
                  </span>
                </div>
              </div>
              <table className="w-full text-sm">
                <thead className="text-slate-500 text-xs uppercase tracking-[0.1em]">
                  <tr>
                    <th className="text-left px-4 py-2">Member</th>
                    <th className="text-left px-3 py-2">Role</th>
                    <th className="text-left px-3 py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {t.members.map((m, i) => (
                    <tr key={`${t.tenant_id}::${m.email ?? "?"}::${i}`} className="border-t border-slate-100 hover:bg-slate-50">
                      <td className="px-4 py-2 text-slate-700">
                        {m.email || <span className="text-slate-400">— (no email)</span>}
                        {m.name && <span className="ml-2 text-slate-400 text-sm">{m.name}</span>}
                      </td>
                      <td className="px-3 py-2">
                        <span className={"inline-block rounded px-1.5 py-0.5 text-xs font-medium " + (ROLE_BADGE[m.role] ?? "bg-slate-100 text-slate-600")}>
                          {m.role}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={
                            "inline-block rounded px-1.5 py-0.5 text-xs font-medium " +
                            (m.status === "invited" ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-800")
                          }
                        >
                          {m.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "amber" }) {
  const c = tone === "amber" ? "text-amber-700" : "text-slate-900";
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 min-w-[110px]">
      <div className="text-xs uppercase tracking-[0.14em] text-slate-500">{label}</div>
      <div className={"font-display font-semibold text-xl mt-0.5 " + c}>{value}</div>
    </div>
  );
}
