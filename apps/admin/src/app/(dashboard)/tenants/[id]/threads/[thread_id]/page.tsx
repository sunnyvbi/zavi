"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { adminApiFetch } from "@/lib/api-admin";
import { Markdown } from "@/components/admin/Markdown";

type Message = {
  id: string;
  sender_role: "user" | "assistant" | "system";
  body: string;
  agent_run_id: string | null;
  created_at: string;
};

type Run = {
  id: string;
  status: string;
  agent_slug: string | null;
  enqueued_at: string | null;
  finished_at: string | null;
  error: string | null;
  trigger: string | null;
};

type Decision = {
  id: string;
  agent_run_id: string | null;
  decision_class: string | null;
  status: string | null;
  emitted_at: string | null;
};

type ThreadResp = {
  thread: {
    id: string;
    agent_slug: string;
    title: string | null;
    created_at: string;
    last_message_at: string;
    deleted: boolean;
    synthetic: boolean;
  };
  messages: Message[];
  runs: Run[];
  decisions: Decision[];
};

const ERROR_STATUSES = new Set(["dispatch_error", "parse_failed", "blocked", "failed"]);

function runChip(r: Run) {
  const bad = ERROR_STATUSES.has(r.status) || r.error != null;
  return (
    <span
      key={r.id}
      title={r.error ?? r.trigger ?? r.status}
      className={
        "rounded px-1.5 py-0.5 text-xs " +
        (bad ? "bg-rose-50 text-rose-700" : "bg-emerald-50 text-emerald-700")
      }
    >
      {r.status}
    </span>
  );
}

export default function TenantThreadTranscriptPage() {
  const params = useParams<{ id: string; thread_id: string }>();
  const tenantId = params?.id;
  const threadId = params?.thread_id;

  const [data, setData] = useState<ThreadResp | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!tenantId || !threadId) return;
    let cancelled = false;
    void (async () => {
      setError(null);
      try {
        const res = await adminApiFetch(`/api/admin/tenants/${tenantId}/threads/${threadId}`);
        const r = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
        if (!cancelled) setData(r as ThreadResp);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId, threadId]);

  const decisionsByRun = new Map<string, Decision[]>();
  for (const d of data?.decisions ?? []) {
    if (!d.agent_run_id) continue;
    decisionsByRun.set(d.agent_run_id, [...(decisionsByRun.get(d.agent_run_id) ?? []), d]);
  }

  return (
    <div className="max-w-5xl mx-auto p-6">
      <Link
        href={`/tenants/${tenantId}/threads`}
        className="text-xs text-slate-500 hover:text-sky-700 hover:underline"
      >
        ← All chat threads
      </Link>

      <div className="mt-2 mb-5">
        <div className="text-xs uppercase tracking-[0.2em] text-sky-700">Zavi · admin</div>
        <h1 className="font-display font-semibold text-2xl text-slate-900 mt-1">
          {data?.thread.title ?? "Transcript"}
        </h1>
        <p className="text-sm text-slate-500 mt-1 flex flex-wrap items-center gap-1.5">
          {data && (
            <>
              <span className="rounded px-1.5 py-0.5 text-xs bg-slate-100 text-slate-600">
                {data.thread.agent_slug}
              </span>
              {data.thread.deleted && (
                <span className="rounded px-1.5 py-0.5 text-xs bg-rose-50 text-rose-700">deleted</span>
              )}
              {data.thread.synthetic && (
                <span className="rounded px-1.5 py-0.5 text-xs bg-amber-50 text-amber-700">synthetic</span>
              )}
              <span>
                {data.messages.length} message{data.messages.length === 1 ? "" : "s"} ·{" "}
                {new Date(data.thread.created_at).toLocaleDateString()}
              </span>
            </>
          )}
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 mb-4">
          {error}
        </div>
      )}

      {!data ? (
        !error && <div className="text-sm text-slate-500">Loading transcript…</div>
      ) : (
        <>
          {data.runs.length > 0 && (
            <div className="glass-card p-3 mb-4">
              <div className="text-xs uppercase tracking-[0.16em] text-slate-500 mb-2">
                Runs on this thread
              </div>
              <div className="flex flex-wrap gap-1.5">{data.runs.map(runChip)}</div>
            </div>
          )}

          {data.messages.length === 0 ? (
            <div className="glass-card border-dashed p-4 text-sm text-slate-500">
              This thread has no messages.
            </div>
          ) : (
            <div className="space-y-3">
              {data.messages.map((m) => {
                const mine = m.sender_role === "user";
                const decs = m.agent_run_id ? decisionsByRun.get(m.agent_run_id) ?? [] : [];
                return (
                  <div key={m.id} className="glass-card p-3">
                    <div className="flex items-center justify-between mb-1.5">
                      <span
                        className={
                          "rounded px-1.5 py-0.5 text-xs " +
                          (mine
                            ? "bg-sky-50 text-sky-700"
                            : m.sender_role === "system"
                              ? "bg-slate-100 text-slate-500"
                              : "bg-emerald-50 text-emerald-700")
                        }
                      >
                        {m.sender_role}
                      </span>
                      <span className="font-mono text-xs text-slate-400">
                        {new Date(m.created_at).toLocaleString()}
                      </span>
                    </div>
                    {}
                    <Markdown>{m.body}</Markdown>
                    {decs.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5 border-t border-slate-100 pt-2">
                        {decs.map((d) => (
                          <span
                            key={d.id}
                            title={d.status ?? undefined}
                            className="rounded px-1.5 py-0.5 text-xs bg-violet-50 text-violet-700"
                          >
                            {d.decision_class ?? "decision"} · {d.status ?? "—"}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
