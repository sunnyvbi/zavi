"use client";

import { useEffect, useState } from "react";
import { adminApiFetch } from "@/lib/api-admin";

type Resp = {
  allowlist: string[];
  source: string;
  note: string;
};

export default function AdminAllowlistPage() {
  return <Body />;
}

function Body() {
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await adminApiFetch("/api/admin/allowlist");
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
  }, []);

  return (
    <div className="max-w-3xl mx-auto p-6">
      <div className="mb-5">
        <div className="text-xs uppercase tracking-[0.2em] text-sky-700">
          Zavi · admin
        </div>
        <h1 className="font-display font-semibold text-2xl text-slate-900 mt-1">Admin allowlist</h1>
      </div>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 mb-4">
          {error}
        </div>
      )}

      {!data ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : (
        <div className="space-y-4">
          <div className="glass-card p-4">
            <div className="text-sm uppercase tracking-[0.14em] text-slate-500 mb-2">
              Current allowlist ({data.allowlist.length})
            </div>
            {data.allowlist.length === 0 ? (
              <div className="text-sm text-slate-500 italic">empty</div>
            ) : (
              <ul className="space-y-1">
                {data.allowlist.map((email) => (
                  <li
                    key={email}
                    className="text-sm text-slate-800 px-2 py-1 rounded bg-slate-50"
                  >
                    {email}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            <div className="text-xs uppercase tracking-[0.14em] mb-1">
              Source: {data.source}
            </div>
            {data.note}
          </div>
        </div>
      )}
    </div>
  );
}
