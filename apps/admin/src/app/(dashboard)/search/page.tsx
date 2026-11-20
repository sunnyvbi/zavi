"use client";

import { useState } from "react";
import Link from "next/link";
import { adminApiFetch } from "@/lib/api-admin";

type Kind = "tenant" | "run" | "decision";
type Result = { kind: Kind; id: string; label: string; tenant_id: string; href: string };
type Resp = { results: Result[] };

const GROUPS: Array<{ kind: Kind; title: string }> = [
  { kind: "tenant", title: "Tenants" },
  { kind: "run", title: "Runs" },
  { kind: "decision", title: "Decisions" },
];

const BADGE: Record<Kind, string> = {
  tenant: "bg-indigo-100 text-indigo-800",
  run: "bg-sky-100 text-sky-800",
  decision: "bg-emerald-100 text-emerald-800",
};

export default function AdminSearchPage() {
  const [q, setQ] = useState("");
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function runSearch(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const term = q.trim();
    setError(null);
    if (term.length < 2) {
      setData({ results: [] });
      return;
    }
    setLoading(true);
    try {
      const res = await adminApiFetch(`/api/admin/search?q=${encodeURIComponent(term)}`);
      const r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
      setData(r as Resp);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-4xl mx-auto p-6">
      <div className="mb-5">
        <div className="text-xs uppercase tracking-[0.2em] text-rose-700">Zavi · admin</div>
        <h1 className="font-display font-semibold text-2xl text-slate-900 mt-1">Global search</h1>
        <p className="text-sm text-slate-500 mt-1">
          Look up any tenant, run, or decision by id, slug, or email.
        </p>
      </div>

      <form onSubmit={runSearch} className="flex gap-2 mb-5">
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="id, slug, or email…"
          className="flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-rose-200 focus:border-rose-400"
        />
        <button
          type="submit"
          disabled={loading || q.trim().length < 2}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-40"
        >
          {loading ? "Searching…" : "Search"}
        </button>
      </form>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 mb-4">{error}</div>
      )}

      {data && data.results.length === 0 && !error && (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-sm text-slate-600 text-center">
          No matches.
        </div>
      )}

      {data && data.results.length > 0 && (
        <div className="space-y-5">
          {GROUPS.map(({ kind, title }) => {
            const rows = data.results.filter((r) => r.kind === kind);
            if (rows.length === 0) return null;
            return (
              <div key={kind}>
                <div className="text-xs uppercase tracking-[0.14em] text-slate-500 mb-2">
                  {title} ({rows.length})
                </div>
                <div className="rounded-xl border border-slate-200 bg-white overflow-hidden divide-y divide-slate-100">
                  {rows.map((r) => (
                    <Link
                      key={r.id}
                      href={r.href}
                      className="flex items-center gap-3 px-3 py-2.5 hover:bg-slate-50"
                    >
                      <span className={"inline-block rounded px-1.5 py-0.5 text-xs font-medium " + BADGE[r.kind]}>
                        {r.kind}
                      </span>
                      <span className="text-sm text-slate-800 truncate">{r.label}</span>
                      <span className="ml-auto font-mono text-sm text-slate-400 truncate">{r.id}</span>
                    </Link>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
