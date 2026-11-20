"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { adminApiFetch } from "@/lib/api-admin";
import { PageHeader } from "@/components/admin/PageHeader";

export type JudgementRow = {
  agent_slug: string; code_signal: string; judge_signal: string | null; source: string;
  surface: string | null; verdict: string; n: number;
};
export type OfferRow = {
  agent_slug: string; code_signal: string; judge_signal: string; source: string;
  surface: string; status: string; n: number;
};
export type Summary = {
  days: 7 | 30;
  totals: { judged: number; judged_bad: number; judge_failed: number; offered: number; strips: number;
            flags: number; sent: number; dismissed: number };
  judgements: JudgementRow[];
  offers: OfferRow[];
};
export type ReportMeta = {
  id: string; tenant_id: string; tenant_slug: string | null; tenant_name: string | null; agent_slug: string;
  signal: string; source: string; created_at: string; has_extra: boolean; note_edited: boolean; status: string;
  thread_id: string | null; message_id: string | null;
};
export type ReportDetail = {
  id: string; tenant_id: string; agent_slug: string; signal: string; source: string; created_at: string;
  note: string; founder_extra: string | null; thread_path: string | null;
};
export type Cursor = { before: string; before_id: string } | null;

type Load<T> = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; data: T };

async function getJson<T>(path: string): Promise<T> {
  const res = await adminApiFetch(path);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
  return body as T;
}

const ERROR_BOX = "rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800";
const EMPTY_BOX = "glass-card border-dashed p-8 text-center text-sm text-slate-500";
const TH = "px-2 py-1.5 text-left font-medium";
const TD = "px-2 py-1.5";

export function SummaryView({ state }: { state: Load<Summary> }) {
  if (state.kind === "loading") return <div className="text-sm text-slate-500">Loading…</div>;
  if (state.kind === "error") return <div className={ERROR_BOX}>{state.message}</div>;
  const s = state.data;
  const t = s.totals;
  const tiles: Array<[string, number]> = [
    ["Replies judged", t.judged], ["Judged bad", t.judged_bad], ["Judge failed", t.judge_failed],
    ["Notes drafted", t.offered], ["Strips", t.strips], ["Flags", t.flags],
    ["Sent by founders", t.sent], ["Dismissed", t.dismissed],
  ];
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {tiles.map(([label, n]) => (
          <div key={label} className="rounded-md border border-slate-200 bg-white p-3">
            <div className="text-xs text-slate-500">{label}</div>
            <div className="mt-0.5 text-xl font-semibold text-slate-900">{n}</div>
          </div>
        ))}
      </div>
      <CountTable
        title="Judge outcomes"
        empty="No replies judged in this window."
        head={["Agent", "Code signal", "Judge signal", "Source", "Surface", "Verdict", "Count"]}
        rows={s.judgements.map((r) => [r.agent_slug, r.code_signal, r.judge_signal ?? "–", r.source, r.surface ?? "–", r.verdict, r.n])}
      />
      <CountTable
        title="Drafted notes"
        empty="No notes drafted in this window."
        head={["Agent", "Code signal", "Judge signal", "Source", "Surface", "Status", "Count"]}
        rows={s.offers.map((r) => [r.agent_slug, r.code_signal, r.judge_signal, r.source, r.surface, r.status, r.n])}
      />
    </div>
  );
}

function CountTable({ title, head, rows, empty }: {
  title: string; head: string[]; rows: Array<Array<string | number>>; empty: string;
}) {
  return (
    <section>
      <h2 className="mb-1.5 text-sm font-semibold text-slate-800">{title}</h2>
      {rows.length === 0 ? (
        <div className={EMPTY_BOX}>{empty}</div>
      ) : (
        <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>{head.map((h) => <th key={h} className={TH}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-t border-slate-100">
                  {r.map((c, j) => (
                    <td key={j} className={`${TD} ${j === r.length - 1 ? "text-right tabular-nums" : ""}`}>{c}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function ReportsList({ state, onOpen, onMore, loadingMore }: {
  state: Load<{ reports: ReportMeta[]; next_cursor: Cursor }>;
  onOpen: (id: string) => void;
  onMore: () => void;
  loadingMore: boolean;
}) {
  if (state.kind === "loading") return <div className="text-sm text-slate-500">Loading…</div>;
  if (state.kind === "error") return <div className={ERROR_BOX}>{state.message}</div>;
  const { reports, next_cursor } = state.data;
  if (reports.length === 0) return <div className={EMPTY_BOX}>No founder has sent a report yet.</div>;
  return (
    <div>
      <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              {["Sent", "Tenant", "Agent", "Signal", "Source", "Edited", "Extra", ""].map((h) => <th key={h} className={TH}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {reports.map((r) => (
              <tr key={r.id} className="border-t border-slate-100">
                <td className={TD}>{new Date(r.created_at).toLocaleString()}</td>
                <td className={TD}>{r.tenant_name ?? r.tenant_slug ?? r.tenant_id}</td>
                <td className={TD}>{r.agent_slug}</td>
                <td className={TD}>{r.signal}</td>
                <td className={TD}>{r.source}</td>
                <td className={TD}>{r.note_edited ? "yes" : "no"}</td>
                <td className={TD}>{r.has_extra ? "yes" : "no"}</td>
                <td className={`${TD} text-right`}>
                  <button type="button" onClick={() => onOpen(r.id)} className="text-sky-700 hover:underline">
                    Read
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {next_cursor && (
        <button type="button" onClick={onMore} disabled={loadingMore}
          className="mt-2 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-60">
          {loadingMore ? "Loading…" : "Load more"}
        </button>
      )}
    </div>
  );
}

export function ReportDrawer({ state, onClose }: { state: Load<ReportDetail>; onClose: () => void }) {
  return (
    <aside role="dialog" aria-modal="true" aria-label="Team report"
      className="fixed inset-y-0 right-0 z-50 flex w-full max-w-lg flex-col gap-3 overflow-y-auto border-l border-slate-200 bg-white p-5 shadow-xl">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-slate-900">Team report</h2>
        <button type="button" onClick={onClose} className="text-sm text-slate-500 hover:text-slate-900">Close</button>
      </div>
      <p className="text-xs text-slate-500">Opening a report is recorded in the audit log.</p>
      {state.kind === "loading" && <div className="text-sm text-slate-500">Loading…</div>}
      {state.kind === "error" && <div className={ERROR_BOX}>{state.message}</div>}
      {state.kind === "ready" && (
        <Fragment>
          <div className="text-sm text-slate-600">
            {new Date(state.data.created_at).toLocaleString()} · {state.data.agent_slug} · {state.data.signal} · {state.data.source}
          </div>
          <section>
            <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">Note</h3>
            <p className="mt-1 whitespace-pre-wrap text-sm text-slate-900">{state.data.note}</p>
          </section>
          {state.data.founder_extra && (
            <section>
              <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">Founder added</h3>
              <p className="mt-1 whitespace-pre-wrap text-sm text-slate-900">{state.data.founder_extra}</p>
            </section>
          )}
          {state.data.thread_path ? (
            <Link href={state.data.thread_path} className="text-sm text-sky-700 hover:underline">Open the chat</Link>
          ) : (
            <p className="text-sm text-slate-500">The chat was deleted.</p>
          )}
        </Fragment>
      )}
    </aside>
  );
}

export function TeamNotesPage() {
  const [days, setDays] = useState<7 | 30>(7);
  const [summary, setSummary] = useState<Load<Summary>>({ kind: "loading" });
  const [reports, setReports] = useState<Load<{ reports: ReportMeta[]; next_cursor: Cursor }>>({ kind: "loading" });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ id: string; load: Load<ReportDetail> } | null>(null);
  const open = useCallback((id: string) => {
    setDetail({ id, load: { kind: "loading" } });
    setOpenId(id);
  }, []);
  const close = useCallback(() => {
    setOpenId(null);
    setDetail(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setSummary({ kind: "loading" });
    getJson<Summary>(`/api/admin/team-notes/summary?days=${days}`)
      .then((data) => { if (!cancelled) setSummary({ kind: "ready", data }); })
      .catch((e) => { if (!cancelled) setSummary({ kind: "error", message: (e as Error).message }); });
    return () => { cancelled = true; };
  }, [days]);

  useEffect(() => {
    let cancelled = false;
    getJson<{ reports: ReportMeta[]; next_cursor: Cursor }>("/api/admin/team-notes/reports")
      .then((data) => { if (!cancelled) setReports({ kind: "ready", data }); })
      .catch((e) => { if (!cancelled) setReports({ kind: "error", message: (e as Error).message }); });
    return () => { cancelled = true; };
  }, []);

  const more = useCallback(async () => {
    if (reports.kind !== "ready" || !reports.data.next_cursor) return;
    const c = reports.data.next_cursor;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const next = await getJson<{ reports: ReportMeta[]; next_cursor: Cursor }>(
        `/api/admin/team-notes/reports?before=${encodeURIComponent(c.before)}&before_id=${encodeURIComponent(c.before_id)}`);
      setReports((p) => (p.kind === "ready"
        ? { kind: "ready", data: { reports: [...p.data.reports, ...next.reports], next_cursor: next.next_cursor } } : p));
    } catch (e) {
      setMoreError((e as Error).message);
    } finally {
      setLoadingMore(false);
    }
  }, [reports]);

  useEffect(() => {
    if (!openId) return;
    const id = openId;
    let cancelled = false;
    const set = (load: Load<ReportDetail>) => {
      if (!cancelled) setDetail((p) => (p && p.id === id ? { id, load } : p));
    };
    getJson<{ report: ReportDetail }>(`/api/admin/team-notes/reports/${id}`)
      .then((b) => set(b.report?.id === id ? { kind: "ready", data: b.report } : { kind: "error", message: "Unexpected report." }))
      .catch((e) => set({ kind: "error", message: (e as Error).message }));
    return () => { cancelled = true; };
  }, [openId]);
  const drawerState: Load<ReportDetail> = detail && detail.id === openId ? detail.load : { kind: "loading" };

  return (
    <div className="mx-auto max-w-6xl p-6">
      <PageHeader
        title="Team notes"
        subtitle="Report to Zavi team: counts only. A note's text is shown only for reports a founder chose to send, one at a time, and each read is audited."
        actions={
          <div className="inline-flex rounded-md border border-slate-200 bg-white p-0.5 text-sm">
            {([7, 30] as const).map((d) => (
              <button key={d} type="button" onClick={() => setDays(d)} aria-pressed={days === d}
                className={`rounded px-3 py-1 ${days === d ? "bg-slate-900 text-white" : "text-slate-700 hover:bg-slate-50"}`}>
                {d} days
              </button>
            ))}
          </div>
        }
      />
      <SummaryView state={summary} />
      <h2 className="mb-1.5 mt-8 text-sm font-semibold text-slate-800">Sent reports</h2>
      <ReportsList state={reports} onOpen={open} onMore={() => void more()} loadingMore={loadingMore} />
      {moreError && <div className={`mt-2 ${ERROR_BOX}`}>{moreError}</div>}
      {openId && <ReportDrawer key={openId} state={drawerState} onClose={close} />}
    </div>
  );
}
