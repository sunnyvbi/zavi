"use client";

import { useEffect, useState } from "react";
import { adminApiFetch } from "@/lib/api-admin";
import { ProductFeedback } from "./ProductFeedback";

type FirehoseRow = {
  id: string;
  tenant_id: string;
  agent_slug: string;
  target_type: string;
  target_id: string;
  rating: number | null;
  comment: string | null;
  created_at: string;
};

export default function AdminFeedbackPage() {
  return <Body />;
}

function Body() {
  const [rows, setRows] = useState<FirehoseRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await adminApiFetch("/api/admin/feedback?limit=200");
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
        if (cancelled) return;
        setRows((body.feedback ?? []) as FirehoseRow[]);
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
    <div className="max-w-5xl mx-auto p-6">
      <div className="text-xs uppercase tracking-[0.2em] text-sky-700">
        Zavi · admin
      </div>
      <h1 className="mt-1 font-display font-semibold text-2xl text-slate-900">
        Feedback firehose
      </h1>
      <p className="text-sm text-slate-600 mt-1">Last 200 thumbs + comments across all tenants.</p>

      <ProductFeedback />

      <h2 className="mt-8 font-display text-lg font-semibold text-slate-900">Thumbs and comments on runs</h2>

        {error && (
          <div className="mt-4 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
            {error}
          </div>
        )}

        {rows === null ? (
          <div className="mt-6 text-sm text-slate-500">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="mt-6 glass-card border-dashed p-8 text-center text-sm text-slate-500">
            No feedback rows yet.
          </div>
        ) : (
          <div className="mt-6 space-y-1.5">
            {rows.map((r) => (
              <div
                key={r.id}
                className="rounded-md border border-slate-200 bg-white p-2.5 text-sm"
              >
                <div className="flex items-center gap-2 text-sm text-slate-500">
                  <span>{new Date(r.created_at).toLocaleString()}</span>
                  <span className="text-slate-400">·</span>
                  <a
                    href={`/tenants/${r.tenant_id}/agents/${encodeURIComponent(r.agent_slug)}`}
                    className="text-slate-700 hover:underline"
                  >
                    {r.agent_slug}
                  </a>
                  <span className="text-slate-400">·</span>
                  <span>{r.target_type}</span>
                  <span className="text-slate-400">·</span>
                  <span>
                    {r.rating === 1 ? "👍" : r.rating === -1 ? "👎" : "comment"}
                  </span>
                </div>
              {r.comment && <div className="mt-1 text-slate-800">{r.comment}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
