"use client";

import { useEffect, useMemo, useState } from "react";
import { adminApiFetch } from "@/lib/api-admin";

type ActivityEvent = {
  id: number;
  tenant_id: string;
  tenant_slug: string | null;
  occurred_at: string;
  actor_type: string;
  verb: string;
  object_type: string | null;
  object_id: string | null;
  source: string;
  confidence: string;
  run_id: string | null;
  detail: Record<string, unknown>;
};

const VERB_TONE: Record<string, string> = {
  "connector.connected": "bg-emerald-100 text-emerald-700",
  "connector.connect_failed": "bg-rose-100 text-rose-700",
  "deliverable.produced": "bg-blue-100 text-blue-700",
};

function relTime(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `${Math.max(mins, 0)}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const d = Math.floor(hrs / 24);
  return d < 30 ? `${d}d ago` : `${Math.floor(d / 30)}mo ago`;
}

export default function ActivityPage() {
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [verb, setVerb] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    setEvents(null);
    setError(null);
    (async () => {
      try {
        const qs = new URLSearchParams({ limit: "200" });
        if (verb) qs.set("verb", verb);
        const res = await adminApiFetch(`/api/admin/activity?${qs.toString()}`);
        const r = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
        if (!cancelled) setEvents((r.events ?? []) as ActivityEvent[]);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [verb]);

  const verbs = useMemo(() => {
    const s = new Set<string>();
    for (const e of events ?? []) s.add(e.verb);
    return [...s].sort();
  }, [events]);

  return (
    <div className="max-w-5xl mx-auto p-6">
      <div className="mb-5">
        <div className="text-xs uppercase tracking-[0.2em] text-rose-700">Zavi · admin</div>
        <h1 className="font-display font-semibold text-2xl text-slate-900 mt-1">Activity</h1>
        <p className="text-sm text-slate-500 mt-1">
          Tenant activity milestones across all tenants (newest first). Reusable spine — activation is one
          consumer.
        </p>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setVerb("")}
          className={`rounded-md border px-3 py-1.5 text-sm ${
            verb === "" ? "bg-slate-900 text-white border-slate-900" : "border-slate-300 text-slate-600 hover:bg-slate-50"
          }`}
        >
          All
        </button>
        {verbs.map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setVerb(v)}
            className={`rounded-md border px-3 py-1.5 text-sm ${
              verb === v ? "bg-slate-900 text-white border-slate-900" : "border-slate-300 text-slate-600 hover:bg-slate-50"
            }`}
          >
            {v}
          </button>
        ))}
      </div>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 mb-4">
          {error}
        </div>
      )}
      {events === null && !error ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : (events?.length ?? 0) === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
          No activity events yet.
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-[0.08em]">
              <tr>
                <th className="text-left px-4 py-2.5">When</th>
                <th className="text-left px-3 py-2.5">Tenant</th>
                <th className="text-left px-3 py-2.5">Event</th>
                <th className="text-left px-3 py-2.5">Detail</th>
                <th className="text-left px-3 py-2.5">Conf</th>
              </tr>
            </thead>
            <tbody>
              {(events ?? []).map((e) => (
                <tr key={e.id} className="border-t border-slate-100">
                  <td className="px-4 py-2 text-sm font-mono text-slate-500 whitespace-nowrap">
                    {relTime(e.occurred_at)}
                  </td>
                  <td className="px-3 py-2">
                    <a
                      href={`/tenants/${e.tenant_id}`}
                      className="text-sm text-slate-900 hover:underline"
                    >
                      {e.tenant_slug ?? e.tenant_id.slice(0, 8)}
                    </a>
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-block rounded px-1.5 py-0.5 text-xs ${
                        VERB_TONE[e.verb] ?? "bg-slate-100 text-slate-600"
                      }`}
                    >
                      {e.verb}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-sm font-mono text-slate-600">
                    {[e.object_id, ...Object.entries(e.detail).map(([k, v]) => `${k}=${v}`)]
                      .filter(Boolean)
                      .join(" · ") || "—"}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`text-xs ${
                        e.confidence === "exact" ? "text-slate-400" : "text-amber-600"
                      }`}
                      title={
                        e.confidence === "exact"
                          ? "Live event"
                          : e.confidence === "inferred"
                            ? "Backfilled — timestamp approximate"
                            : "Narrow source (run_artifacts only) — misses some deliverables"
                      }
                    >
                      {e.confidence}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
