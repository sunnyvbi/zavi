"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { adminApiFetch } from "@/lib/api-admin";
import { PageHeader } from "@/components/admin/PageHeader";

type Tenant = { id: string; slug: string; display_name: string | null };

type Goal = {
  id: string;
  objective: string;
  target_metric: string;
  target_value: number;
  baseline_value: number | null;
  current_value: number | null;
  due_date: string | null;
  status: string;
  updated_at: string | null;
};

type Item = {
  id: string;
  title: string;
  detail: string;
  priority: "P0" | "P1" | "P2";
  source: string;
  source_ref: string | null;
  status: "open" | "snoozed" | "done";
  snooze_until: string | null;
  created_by: string;
  created_at: string;
  done_at: string | null;
};

type PendingDecision = {
  id: string;
  decision_class: string;
  body: Record<string, unknown> | null;
  emitted_at: string;
};

type Run = {
  id: string;
  agent_slug: string;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  enqueued_at: string | null;
  quality_score: number | null;
  trigger: string | null;
};

type Board = {
  goal: Goal | null;
  items: Item[];
  pending_decisions: PendingDecision[];
  done_today: Item[];
};

const PRIORITY_STYLE: Record<Item["priority"], { card: string; dot: string }> = {
  P0: { card: "border-rose-300 border-l-4 border-l-rose-600", dot: "text-rose-700" },
  P1: { card: "border-amber-300 border-l-4 border-l-amber-500", dot: "text-amber-700" },
  P2: { card: "border-slate-200 border-l-4 border-l-slate-400", dot: "text-slate-600" },
};

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function countdown(due: string | null): { label: string; overdue: boolean } | null {
  if (!due) return null;
  const t = due.length <= 10 ? new Date(`${due}T23:59:59`).getTime() : new Date(due).getTime();
  if (Number.isNaN(t)) return null;
  const ms = t - Date.now();
  if (ms <= 0) return { label: "overdue", overdue: true };
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return { label: h >= 48 ? `${Math.floor(h / 24)}d ${h % 24}h left` : `${h}h ${m}m left`, overdue: false };
}

function runBadge(status: string): string {
  if (status === "success") return "bg-emerald-50 text-emerald-700";
  if (status === "running" || status === "queued") return "bg-amber-50 text-amber-700";
  return "bg-rose-50 text-rose-700";
}

export default function HumanActionsPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-slate-500">Loading…</div>}>
      <HumanActionsBoard />
    </Suspense>
  );
}

function HumanActionsBoard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tenantParam = searchParams?.get("tenant") ?? null;

  const [tenants, setTenants] = useState<Tenant[] | null>(null);
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await adminApiFetch("/api/admin/tenants");
        const r = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
        if (cancelled) return;
        const list = (r.tenants ?? []) as Tenant[];
        setTenants(list);
        const match = tenantParam ? list.find((t) => t.id === tenantParam || t.slug === tenantParam) : null;
        setTenantId((cur) => cur ?? match?.id ?? list[0]?.id ?? null);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!tenantId) return;
    let cancelled = false;
    (async () => {
      setError(null);
      try {
        const [bRes, rRes] = await Promise.all([
          adminApiFetch(`/api/admin/human-actions?tenant_id=${tenantId}`),
          adminApiFetch(`/api/admin/runs?tenant_id=${tenantId}&limit=10`),
        ]);
        const b = await bRes.json().catch(() => ({}));
        if (!bRes.ok) throw new Error(b?.error?.message ?? `HTTP ${bRes.status}`);
        const r = await rRes.json().catch(() => ({}));
        if (!rRes.ok) throw new Error(r?.error?.message ?? `HTTP ${rRes.status}`);
        if (cancelled) return;
        setBoard(b as Board);
        setRuns((r.runs ?? []) as Run[]);
        setLastRefreshed(new Date());
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId, nonce]);

  useEffect(() => {
    const t = setInterval(() => setNonce((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);

  function pickTenant(id: string) {
    setTenantId(id);
    setBoard(null);
    setRuns(null);
    const slug = tenants?.find((t) => t.id === id)?.slug ?? id;
    router.replace(`/human-actions?tenant=${encodeURIComponent(slug)}`);
  }

  async function post(path: string, body: unknown, busyKey: string) {
    setBusyId(busyKey);
    setError(null);
    try {
      const res = await adminApiFetch(path, { method: "POST", body: JSON.stringify(body) });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  const itemDone = (it: Item) => post(`/api/admin/human-actions/${it.id}/status`, { status: "done" }, it.id);
  const itemSnooze = (it: Item) =>
    post(
      `/api/admin/human-actions/${it.id}/status`,
      { status: "snoozed", snooze_until: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() },
      it.id,
    );
  const decide = (d: PendingDecision, action: "approve" | "reject") =>
    post(`/api/admin/decisions/${d.id}/decide`, { action }, d.id);

  const goal = board?.goal ?? null;
  const due = countdown(goal?.due_date ?? null);
  const pct =
    goal && goal.target_value > 0
      ? Math.max(0, Math.min(100, Math.round(((goal.current_value ?? 0) / goal.target_value) * 100)))
      : 0;
  const openCount = board?.items.length ?? 0;

  return (
    <div className="max-w-6xl mx-auto p-6">
      <PageHeader
        title="Human Actions"
        actions={
          <>
            <select
              value={tenantId ?? ""}
              onChange={(e) => pickTenant(e.target.value)}
              className="rounded-md border border-slate-300 px-2 py-1.5 text-sm bg-white/70 focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-100"
            >
              {(tenants ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.display_name ?? t.slug} ({t.slug})
                </option>
              ))}
            </select>
            <span className="text-sm text-slate-400 whitespace-nowrap">
              auto-refresh 60s{lastRefreshed ? ` · last ${lastRefreshed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}
            </span>
          </>
        }
      />

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 mb-4">{error}</div>
      )}

      {}
      {tenantId && (
        <GoalBar
          key={tenantId}
          tenantId={tenantId}
          goal={goal}
          pct={pct}
          due={due}
          onSaved={refresh}
        />
      )}

      <div className="flex gap-4 mt-4 items-start flex-col lg:flex-row">
        {}
        <div className="flex-1 w-full min-w-0">
          <div className="text-xs uppercase tracking-[0.1em] text-slate-500 mb-2">
            Agents doing <span className="text-slate-400">(read-only, live runs)</span>
          </div>
          {runs === null ? (
            <div className="text-sm text-slate-500">Loading runs…</div>
          ) : runs.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-300 bg-white p-5 text-sm text-slate-500">
              No runs yet for this tenant.
            </div>
          ) : (
            runs.map((r) => (
              <div key={r.id} className="rounded-lg border border-dashed border-slate-300 bg-white px-3 py-2 mb-2">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-sm text-slate-900">{r.agent_slug}</span>
                  <span className={`rounded px-1.5 py-0.5 text-xs ${runBadge(r.status)}`}>
                    {r.status}
                    {r.quality_score != null ? ` · q${r.quality_score}` : ""}
                  </span>
                  <span className="ml-auto text-sm text-slate-400 font-mono">
                    {fmtTime(r.finished_at ?? r.started_at ?? r.enqueued_at)}
                  </span>
                </div>
                <div className="mt-0.5 text-sm text-slate-500">
                  {r.trigger ? `trigger: ${r.trigger} · ` : ""}
                  <Link href={`/runs/${r.id}`} className="underline hover:text-slate-700">
                    open run
                  </Link>
                </div>
              </div>
            ))
          )}
          <div className="text-sm text-slate-400 mt-1">last 10 runs · click-through to run detail</div>
        </div>

        {}
        <div className="flex-1 w-full min-w-0">
          <div className="text-xs uppercase tracking-[0.1em] text-slate-500 mb-2">
            Humans must do <span className="text-slate-400">({openCount + (board?.pending_decisions.length ?? 0)} open)</span>
          </div>

          {board === null ? (
            <div className="text-sm text-slate-500">Loading board…</div>
          ) : (
            <>
              {board.items.length === 0 && board.pending_decisions.length === 0 && (
                <div className="rounded-lg border border-dashed border-slate-300 bg-white p-5 text-sm text-slate-500 mb-2">
                  Nothing for humans right now. 🎉
                </div>
              )}

              {board.items.map((it) => {
                const s = PRIORITY_STYLE[it.priority] ?? PRIORITY_STYLE.P2;
                const busy = busyId === it.id;
                return (
                  <div key={it.id} className={`rounded-lg border bg-white px-3 py-2 mb-2 ${s.card}`}>
                    <div className="text-sm text-slate-900">
                      <span className={`text-sm font-semibold ${s.dot}`}>{it.priority}</span>{" "}
                      <span className="font-semibold">{it.title}</span>
                      {it.status === "snoozed" && (
                        <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
                          snoozed{it.snooze_until ? ` → ${fmtTime(it.snooze_until)}` : ""}
                        </span>
                      )}
                    </div>
                    {it.detail && (
                      <details className="mt-1">
                        <summary className="text-sm text-slate-500 cursor-pointer">detail ▾</summary>
                        <pre className="whitespace-pre-wrap text-sm text-slate-600 font-sans mt-1">{it.detail}</pre>
                      </details>
                    )}
                    <div className="text-sm text-slate-400 mt-1">
                      source: {it.source}
                      {it.source_ref ? ` ${it.source_ref}` : ""} · added by {it.created_by} {fmtTime(it.created_at)}
                    </div>
                    <div className="mt-1.5">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => itemDone(it)}
                        className="text-sm rounded-md bg-slate-900 text-white px-2 py-1 mr-1.5 disabled:opacity-50"
                      >
                        ✓ Done
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => itemSnooze(it)}
                        className="text-sm rounded-md border border-slate-300 text-slate-600 px-2 py-1 disabled:opacity-50"
                      >
                        Snooze 1d
                      </button>
                    </div>
                  </div>
                );
              })}

              {board.pending_decisions.map((d) => {
                const busy = busyId === d.id;
                return (
                  <div
                    key={d.id}
                    className="rounded-lg border border-amber-300 border-l-4 border-l-amber-500 bg-white px-3 py-2 mb-2"
                  >
                    <div className="text-sm text-slate-900">
                      <span className="text-sm font-semibold text-amber-700">DECISION</span>{" "}
                      <span className="font-semibold">{d.decision_class}</span>
                    </div>
                    {d.body && (
                      <details className="mt-1">
                        <summary className="text-sm text-slate-500 cursor-pointer">view body ▾</summary>
                        <pre className="whitespace-pre-wrap text-sm text-slate-600 font-mono mt-1 max-h-48 overflow-auto">
                          {JSON.stringify(d.body, null, 2)}
                        </pre>
                      </details>
                    )}
                    <div className="text-sm text-slate-400 mt-1">
                      pending decision {d.id.slice(0, 8)} · emitted {fmtTime(d.emitted_at)} · runs the existing decision pipeline
                    </div>
                    <div className="mt-1.5">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => decide(d, "approve")}
                        className="text-sm rounded-md bg-emerald-600 text-white px-2 py-1 mr-1.5 disabled:opacity-50"
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => decide(d, "reject")}
                        className="text-sm rounded-md border border-rose-300 text-rose-700 px-2 py-1 disabled:opacity-50"
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                );
              })}

              {tenantId && <AddItemForm tenantId={tenantId} onAdded={refresh} />}

              {board.done_today.length > 0 && (
                <details className="mt-2">
                  <summary className="text-sm text-slate-400 cursor-pointer">
                    Done today ({board.done_today.length}) ▸
                  </summary>
                  {board.done_today.map((it) => (
                    <div key={it.id} className="text-sm text-slate-400 line-through px-1 py-0.5">
                      {it.title} · done {fmtTime(it.done_at)} by {it.created_by}
                    </div>
                  ))}
                </details>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function GoalBar({
  tenantId,
  goal,
  pct,
  due,
  onSaved,
}: {
  tenantId: string;
  goal: Goal | null;
  pct: number;
  due: { label: string; overdue: boolean } | null;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [objective, setObjective] = useState(goal?.objective ?? "");
  const [metric, setMetric] = useState(goal?.target_metric ?? "");
  const [target, setTarget] = useState(goal ? String(goal.target_value) : "");
  const [current, setCurrent] = useState(goal?.current_value != null ? String(goal.current_value) : "");
  const [dueDate, setDueDate] = useState(goal?.due_date ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function openEditor() {
    setObjective(goal?.objective ?? "");
    setMetric(goal?.target_metric ?? "");
    setTarget(goal ? String(goal.target_value) : "");
    setCurrent(goal?.current_value != null ? String(goal.current_value) : "");
    setDueDate(goal?.due_date ?? "");
    setError(null);
    setEditing(true);
  }

  async function save() {
    const targetNum = Number(target);
    if (!objective.trim() || !metric.trim() || !Number.isFinite(targetNum)) {
      setError("objective, target_metric and a numeric target_value are required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        objective: objective.trim(),
        target_metric: metric.trim(),
        target_value: targetNum,
      };
      if (dueDate.trim()) body.due_date = dueDate.trim();
      if (current.trim() && Number.isFinite(Number(current))) body.current_value = Number(current);
      const res = await adminApiFetch(`/api/admin/tenants/${tenantId}/goal`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
      setEditing(false);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border-2 border-slate-300 bg-slate-50 px-4 py-3">
      {goal ? (
        <>
          <div className="flex items-center gap-3 flex-wrap">
            <div className="font-semibold text-base text-slate-900">🎯 {goal.objective}</div>
            <div className="flex-1 min-w-[120px] h-3.5 rounded-full bg-slate-200 overflow-hidden">
              <div className="h-full bg-emerald-500 transition-[width]" style={{ width: `${pct}%` }} />
            </div>
            <div className="font-semibold text-sm text-slate-900 font-mono">
              {goal.current_value ?? 0} / {goal.target_value}
            </div>
            {due && (
              <div className={`text-sm font-semibold ${due.overdue ? "text-rose-700" : "text-amber-700"}`}>
                ⏳ {due.label}
              </div>
            )}
          </div>
          <div className="text-sm text-slate-500 mt-1.5">
            target_metric: {goal.target_metric}
            {goal.due_date ? ` · due ${goal.due_date}` : ""}
            {goal.updated_at ? ` · updated ${fmtTime(goal.updated_at)}` : ""} ·{" "}
            <button type="button" onClick={openEditor} className="underline hover:text-slate-700">
              edit goal
            </button>
          </div>
        </>
      ) : (
        <div className="flex items-center gap-3">
          <div className="text-sm text-slate-600">No active goal for this tenant.</div>
          <button
            type="button"
            onClick={openEditor}
            className="text-sm rounded-md bg-slate-900 text-white px-2 py-1"
          >
            Set goal
          </button>
        </div>
      )}

      {editing && (
        <div className="mt-3 rounded-lg border border-slate-300 bg-white p-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <input
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              placeholder="Objective (e.g. 5 real tutors signed up)"
              className="rounded-md border border-slate-300 px-2 py-1.5 text-sm sm:col-span-2"
            />
            <input
              value={metric}
              onChange={(e) => setMetric(e.target.value)}
              placeholder="target_metric (e.g. tutor_signups)"
              className="rounded-md border border-slate-300 px-2 py-1.5 text-sm font-mono"
            />
            <div className="flex gap-2">
              <input
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder="target"
                inputMode="numeric"
                className="w-24 rounded-md border border-slate-300 px-2 py-1.5 text-sm font-mono"
              />
              <input
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                placeholder="current"
                inputMode="numeric"
                className="w-24 rounded-md border border-slate-300 px-2 py-1.5 text-sm font-mono"
              />
              <input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                className="flex-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm font-mono"
              />
            </div>
          </div>
          {error && <div className="mt-2 text-sm text-rose-700">{error}</div>}
          <div className="mt-2 flex gap-2 justify-end">
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="rounded-md border border-slate-300 px-2.5 py-1 text-sm text-slate-600"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={save}
              className="rounded-md bg-emerald-600 text-white px-2.5 py-1 text-sm disabled:opacity-50"
            >
              {busy ? "Saving…" : "Save goal"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function AddItemForm({ tenantId, onAdded }: { tenantId: string; onAdded: () => void }) {
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [priority, setPriority] = useState<"P0" | "P1" | "P2">("P1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    if (!title.trim()) {
      setError("Title required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await adminApiFetch("/api/admin/human-actions", {
        method: "POST",
        body: JSON.stringify({ tenant_id: tenantId, title: title.trim(), detail, priority }),
      });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
      setTitle("");
      setDetail("");
      setPriority("P1");
      onAdded();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-dotted border-slate-300 bg-slate-50/60 px-3 py-2.5 mt-2">
      <div className="text-xs uppercase tracking-[0.1em] text-slate-500 mb-1.5">+ Add item</div>
      <div className="flex gap-2">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title (imperative, short)"
          className="flex-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
        />
        <select
          value={priority}
          onChange={(e) => setPriority(e.target.value as "P0" | "P1" | "P2")}
          className="rounded-md border border-slate-300 px-2 py-1.5 text-sm bg-white"
        >
          <option value="P0">P0</option>
          <option value="P1">P1</option>
          <option value="P2">P2</option>
        </select>
      </div>
      <textarea
        value={detail}
        onChange={(e) => setDetail(e.target.value)}
        placeholder="Detail (markdown: links, drafts, lists)…"
        rows={2}
        className="w-full mt-2 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
      />
      {error && <div className="mt-1 text-sm text-rose-700">{error}</div>}
      <div className="mt-1.5 flex justify-end">
        <button
          type="button"
          disabled={busy}
          onClick={add}
          className="rounded-md bg-slate-900 text-white px-2.5 py-1 text-sm disabled:opacity-50"
        >
          {busy ? "Adding…" : "Add"}
        </button>
      </div>
    </div>
  );
}
