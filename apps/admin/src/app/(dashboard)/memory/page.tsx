"use client";

import { useEffect, useState } from "react";
import { adminApiFetch } from "@/lib/api-admin";

type Note = {
  id: string;
  tenant_id: string;
  title: string;
  body_markdown: string;
  source: string;
  source_ref: string | null;
  tags: string[] | null;
  created_at: string;
  updated_at: string;
};

export default function AdminMemoryPage() {
  return <Body />;
}

function Body() {
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState("");
  const [tag, setTag] = useState("");
  const [q, setQ] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const qs = new URLSearchParams();
        if (source) qs.set("source", source);
        if (tag) qs.set("tag", tag);
        if (q.trim()) qs.set("q", q.trim());
        qs.set("limit", "50");
        const res = await adminApiFetch(`/api/admin/memory?${qs.toString()}`);
        const r = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
        if (cancelled) return;
        setNotes((r.notes ?? []) as Note[]);
      } catch (e) {
        if (cancelled) return;
        setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source, tag, q]);

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="flex items-center justify-between mb-5">
        <div>
          <div className="text-xs uppercase tracking-[0.2em] text-sky-700">
            Zavi · admin
          </div>
          <h1 className="font-display font-semibold text-2xl text-slate-900 mt-1">
            Memory
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <input
            placeholder="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm w-44"
          />
          <input
            placeholder="source"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm w-36"
          />
          <input
            placeholder="tag"
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm w-36"
          />
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 mb-4">
          {error}
        </div>
      )}

      {notes === null ? (
        <div className="text-sm text-slate-500">Loading notes…</div>
      ) : notes.length === 0 ? (
        <div className="glass-card border-dashed p-8 text-sm text-slate-600 text-center">
          No notes match.
        </div>
      ) : (
        <ul className="space-y-3">
          {notes.map((n) => (
            <li key={n.id} className="glass-card p-4">
              <div className="flex items-baseline justify-between gap-3">
                <div className="font-display font-semibold text-base text-slate-900 truncate">
                  {n.title || <span className="italic text-slate-500">untitled</span>}
                </div>
                <div className="text-sm font-mono text-slate-500 whitespace-nowrap">
                  {new Date(n.updated_at).toLocaleString()}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 mt-1.5 text-xs text-slate-500">
                <span>tenant:{n.tenant_id.slice(0, 8)}</span>
                <span>·</span>
                <span>source:{n.source}</span>
                {n.tags && n.tags.length > 0 && (
                  <>
                    <span>·</span>
                    {n.tags.slice(0, 6).map((t) => (
                      <span
                        key={t}
                        className="inline-flex items-center rounded bg-slate-100 px-1.5 py-0.5"
                      >
                        {t}
                      </span>
                    ))}
                  </>
                )}
              </div>
              {n.body_markdown && (
                <pre className="mt-2 text-sm font-mono whitespace-pre-wrap break-words text-slate-700 max-h-32 overflow-hidden">
                  {n.body_markdown}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
