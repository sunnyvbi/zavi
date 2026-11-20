"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { adminApiFetch } from "@/lib/api-admin";

type Task = {
  id: string;
  kind: "enrichment" | "unblock";
  tenant_id: string;
  source_decision_id: string | null;
  source_run_id: string | null;
  block_reason: string | null;
  state: string;
  assignee_staff_email: string | null;
  snooze_until: string | null;
  priority: number;
  resolution: Record<string, unknown> | null;
  created_at: string;
  claimed_at: string | null;
  resolved_at: string | null;
};

const TABS = [
  { key: "active", label: "Open" },
  { key: "snoozed", label: "Snoozed" },
  { key: "resolved", label: "Resolved" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

const ANCHOR_SLUGS = ["company", "ops", "policies", "disputes", "support"] as const;

export default function AdminTasksPage() {
  const [tab, setTab] = useState<TabKey>("active");
  const [rows, setRows] = useState<Task[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Task | null>(null);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setError(null);
      try {
        const qs = new URLSearchParams();
        if (tab === "snoozed") qs.set("state", "snoozed");
        else if (tab === "resolved") qs.set("state", "resolved");
        qs.set("limit", "100");
        const res = await adminApiFetch(`/api/admin/admin-tasks?${qs.toString()}`);
        const r = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
        if (cancelled) return;
        setRows((r.tasks ?? []) as Task[]);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tab, nonce]);

  async function act(task: Task, action: "claim" | "resolve" | "dismiss" | "snooze", body?: unknown) {
    setBusyId(task.id);
    setError(null);
    try {
      const res = await adminApiFetch(`/api/admin/admin-tasks/${task.id}/${action}`, {
        method: "POST",
        body: body ? JSON.stringify(body) : undefined,
      });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  function snooze(task: Task) {
    const until = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
    void act(task, "snooze", { until });
  }

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="flex items-center justify-between mb-5">
        <div>
          <div className="text-xs uppercase tracking-[0.2em] text-sky-700">
            Zavi · admin
          </div>
          <h1 className="font-display font-semibold text-2xl text-slate-900 mt-1">Agent-assist tasks</h1>
          <p className="text-sm text-slate-500 mt-1">
            Help the agents that are stuck or need company info. Every action is logged and shown to the customer.
          </p>
        </div>
        <div className="inline-flex glass-card p-0.5">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={
                "px-3 py-1.5 text-sm rounded-md transition-colors " +
                (tab === t.key ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100")
              }
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 mb-4">
          {error}
        </div>
      )}

      {rows === null ? (
        <div className="text-sm text-slate-500">Loading tasks…</div>
      ) : rows.length === 0 ? (
        <div className="glass-card border-dashed p-8 text-sm text-slate-600 text-center">
          No tasks here. Agents are running clean. 🎉
        </div>
      ) : (
        <div className="glass-card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-white/50 text-slate-600 text-xs uppercase tracking-[0.1em]">
              <tr>
                <th className="text-left px-3 py-2.5">Created</th>
                <th className="text-left px-3 py-2.5">Kind</th>
                <th className="text-left px-3 py-2.5">Tenant</th>
                <th className="text-left px-3 py-2.5">Reason</th>
                <th className="text-left px-3 py-2.5">State</th>
                <th className="text-left px-3 py-2.5">Assignee</th>
                <th className="text-right px-3 py-2.5">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => {
                const busy = busyId === t.id;
                const terminal = t.state === "resolved" || t.state === "dismissed";
                return (
                  <tr key={t.id} className="border-t border-slate-100 hover:bg-slate-50">
                    <td className="px-3 py-2 font-mono text-slate-500 text-sm whitespace-nowrap">
                      {new Date(t.created_at).toLocaleString()}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={
                          "inline-block rounded px-1.5 py-0.5 text-xs " +
                          (t.kind === "enrichment"
                            ? "bg-emerald-50 text-emerald-700"
                            : "bg-amber-50 text-amber-700")
                        }
                      >
                        {t.kind}
                      </span>
                    </td>
                    <td className="px-3 py-2 font-mono text-slate-600 text-sm">{t.tenant_id.slice(0, 8)}</td>
                    <td className="px-3 py-2 text-slate-600">{t.block_reason ?? "—"}</td>
                    <td className="px-3 py-2 text-slate-700">{t.state}</td>
                    <td className="px-3 py-2 text-slate-500 text-sm">
                      {t.assignee_staff_email ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      {t.source_run_id && (
                        <Link
                          href={`/runs/${t.source_run_id}`}
                          className="text-sm text-slate-600 hover:underline mr-2"
                        >
                          transcript
                        </Link>
                      )}
                      {!terminal && t.state === "open" && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => act(t, "claim")}
                          className="text-sm rounded-md bg-slate-900 text-white px-2 py-1 mr-1 disabled:opacity-50"
                        >
                          Claim
                        </button>
                      )}
                      {!terminal && t.kind === "enrichment" && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setEditing(t)}
                          className="text-sm rounded-md border border-emerald-300 text-emerald-700 px-2 py-1 mr-1 disabled:opacity-50"
                        >
                          Enrich
                        </button>
                      )}
                      {!terminal && (
                        <>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => snooze(t)}
                            className="text-sm rounded-md border border-slate-300 text-slate-600 px-2 py-1 mr-1 disabled:opacity-50"
                          >
                            Snooze
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => act(t, "resolve", { resolution: { via: "manual" } })}
                            className="text-sm rounded-md border border-slate-300 text-slate-700 px-2 py-1 mr-1 disabled:opacity-50"
                          >
                            Resolve
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => act(t, "dismiss", { reason: "not actionable" })}
                            className="text-sm rounded-md text-slate-400 hover:text-slate-600 px-1.5 py-1 disabled:opacity-50"
                          >
                            Dismiss
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <EnrichPanel
          task={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function EnrichPanel({
  task,
  onClose,
  onSaved,
}: {
  task: Task;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [slug, setSlug] = useState<(typeof ANCHOR_SLUGS)[number]>("company");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!body.trim()) {
      setError("Body is empty.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await adminApiFetch(`/api/admin/admin-tasks/${task.id}/enrich-memory`, {
        method: "POST",
        body: JSON.stringify({ slug, body_markdown: body }),
      });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div className="w-full max-w-2xl glass-card p-5 shadow-xl">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-display font-semibold text-lg text-slate-900">
            Enrich company memory · {task.tenant_id.slice(0, 8)}
          </h2>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600 text-sm">
            Close
          </button>
        </div>
        <p className="text-sm text-slate-500 mb-3">
          Saved edits re-embed and apply to the agent&apos;s next run. The customer sees &quot;edited by Zavi team.&quot;
        </p>
        <div className="flex items-center gap-2 mb-3">
          <label className="text-sm text-slate-600">Anchor</label>
          <select
            value={slug}
            onChange={(e) => setSlug(e.target.value as (typeof ANCHOR_SLUGS)[number])}
            className="rounded-md border border-slate-300 px-2 py-1 text-sm"
          >
            {ANCHOR_SLUGS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Enriched company info for this anchor (markdown)…"
          rows={10}
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
        {error && <div className="mt-2 text-sm text-rose-700">{error}</div>}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-600"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={save}
            className="rounded-md bg-emerald-600 text-white px-3 py-1.5 text-sm disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save anchor"}
          </button>
        </div>
      </div>
    </div>
  );
}
