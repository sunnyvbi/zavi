"use client";

import { useEffect, useState } from "react";
import { adminApiFetch } from "@/lib/api-admin";
import { blobFromRows, newRow, rowsFromBlob, type LiveRunRow } from "./liveRunsForm";

const WEB = process.env.NEXT_PUBLIC_WEB_ORIGIN ?? "https://www.zaviagent.com";
const input = "w-full rounded-md border border-slate-300 px-2 py-1 text-sm focus:outline-none focus:border-skyMuted";

export function LiveRunsCard({ blob, onSaved }: { blob: Record<string, unknown>; onSaved: () => void }) {
  const [rows, setRows] = useState<LiveRunRow[]>(() => rowsFromBlob(blob));
  const [newSlug, setNewSlug] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  useEffect(() => setRows(rowsFromBlob(blob)), [blob]);

  const set = (i: number, patch: Partial<LiveRunRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  async function save() {
    setSaving(true);
    setMsg(null);
    try {
      const res = await adminApiFetch("/api/admin/config", { method: "PATCH", body: JSON.stringify({ patch: { live_runs: blobFromRows(rows) } }) });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
      setMsg({ kind: "ok", text: "Saved. Pages pick it up within 5 minutes." });
      onSaved();
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mb-6 rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-display font-semibold text-slate-900">Live pages</h2>
        <span className="font-mono text-xs text-slate-400">live_runs</span>
      </div>
      <p className="mt-1 text-sm text-slate-500">
        Each run is its own page at /live/&lt;slug&gt;. Times are US Eastern. Leave Unlock empty to show numbers from the start.
        Only one run can have the home page Live pill.
      </p>

      {rows.length === 0 && <p className="mt-3 text-sm text-slate-500">No runs yet.</p>}
      {rows.map((r, i) => (
        <div key={r.slug} className="mt-4 rounded-md border border-slate-200 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <a className="font-mono text-sm font-semibold text-sky-700 underline" href={`${WEB}/live/${r.slug}`} target="_blank" rel="noreferrer">/live/{r.slug}</a>
            <div className="flex items-center gap-4 text-sm">
              <label className="flex items-center gap-1.5"><input type="checkbox" checked={r.public} onChange={(e) => set(i, { public: e.target.checked })} /> Public</label>
              <label className="flex items-center gap-1.5"><input type="checkbox" checked={r.home_pill} onChange={(e) => set(i, { home_pill: e.target.checked })} /> Home pill</label>
              <button type="button" className="text-rose-700 hover:underline" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>Remove</button>
            </div>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <label className="text-xs text-slate-500">Start (ET)<input type="datetime-local" className={input} value={r.start} onChange={(e) => set(i, { start: e.target.value })} /></label>
            <label className="text-xs text-slate-500">Unlock (ET, optional)<input type="datetime-local" className={input} value={r.unlock} onChange={(e) => set(i, { unlock: e.target.value })} /></label>
            <label className="text-xs text-slate-500">End (ET)<input type="datetime-local" className={input} value={r.end} onChange={(e) => set(i, { end: e.target.value })} /></label>
            <label className="text-xs text-slate-500">Budget ($)<input type="number" min={1} className={input} value={r.budget_usd} onChange={(e) => set(i, { budget_usd: e.target.value })} /></label>
            <label className="text-xs text-slate-500">Budget at the start, if raised ($)<input type="number" min={1} className={input} value={r.raise_start_usd} onChange={(e) => set(i, { raise_start_usd: e.target.value })} /></label>
            <label className="text-xs text-slate-500">Raised on<input type="date" className={input} value={r.raise_on} onChange={(e) => set(i, { raise_on: e.target.value })} /></label>
            <label className="text-xs text-slate-500">Goal: bookings<input type="number" min={1} className={input} value={r.goal_bookings} onChange={(e) => set(i, { goal_bookings: e.target.value })} /></label>
            <label className="text-xs text-slate-500">Goal: new hosts<input type="number" min={1} className={input} value={r.goal_hosts} onChange={(e) => set(i, { goal_hosts: e.target.value })} /></label>
            <label className="text-xs text-slate-500">Goal: $ booked (optional)<input type="number" min={1} className={input} value={r.goal_value_usd} onChange={(e) => set(i, { goal_value_usd: e.target.value })} /></label>
            <label className="text-xs text-slate-500">Bookings multiplier (1 to 3, blank = 1)<input type="number" min={1} max={3} step={0.05} placeholder="1" className={input} value={r.bookings_factor} onChange={(e) => set(i, { bookings_factor: e.target.value })} /></label>
            <div className="sm:col-span-3">
              <p className="text-xs font-medium text-slate-600">Correct numbers</p>
              <p className="text-xs text-slate-500">Use when Upcar's feed is down or wrong. A number here replaces the automatic one for that day (Pacific date); leave a box empty to keep it automatic.</p>
              {r.fixes.map((f, k) => {
                const setFix = (patch: Partial<typeof f>) => set(i, { fixes: r.fixes.map((x, m) => (m === k ? { ...x, ...patch } : x)) });
                return (
                  <div key={k} className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-5">
                    <input type="date" aria-label="Day" className={input} value={f.day} onChange={(e) => setFix({ day: e.target.value })} />
                    <input type="number" min={0} step={1} placeholder="Bookings" aria-label="Bookings" className={input} value={f.bookings} onChange={(e) => setFix({ bookings: e.target.value })} />
                    <input type="number" min={0} step={1} placeholder="New hosts" aria-label="New hosts" className={input} value={f.hosts} onChange={(e) => setFix({ hosts: e.target.value })} />
                    <input type="number" min={0} step={0.01} placeholder="Spend ($)" aria-label="Spend" className={input} value={f.spent_usd} onChange={(e) => setFix({ spent_usd: e.target.value })} />
                    <input type="number" min={0} step={1} placeholder="$ booked" aria-label="Dollars booked" className={input} value={f.booking_value_usd} onChange={(e) => setFix({ booking_value_usd: e.target.value })} />
                    <button type="button" className="text-left text-sm text-rose-700 hover:underline" onClick={() => set(i, { fixes: r.fixes.filter((_, m) => m !== k) })}>Back to automatic</button>
                  </div>
                );
              })}
              <button type="button" className="mt-2 text-sm text-sky-700 hover:underline" onClick={() => set(i, { fixes: [...r.fixes, { day: "", bookings: "", hosts: "", spent_usd: "", booking_value_usd: "" }] })}>+ Correct a day</button>
            </div>
            <label className="text-xs text-slate-500 sm:col-span-3">Tenant id<input className={`${input} font-mono`} value={r.tenant_id} onChange={(e) => set(i, { tenant_id: e.target.value })} /></label>
          </div>
        </div>
      ))}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <input className={`${input} max-w-[220px] font-mono`} placeholder="new-slug, e.g. upcar-test" value={newSlug} onChange={(e) => setNewSlug(e.target.value.toLowerCase())} />
        <button
          type="button"
          disabled={!/^[a-z0-9][a-z0-9-]{0,39}$/.test(newSlug) || rows.some((r) => r.slug === newSlug)}
          onClick={() => { setRows((rs) => [...rs, newRow(newSlug)]); setNewSlug(""); }}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
        >
          Add run
        </button>
        <button type="button" onClick={save} disabled={saving} className="ml-auto rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50">
          {saving ? "Saving…" : "Save live pages"}
        </button>
      </div>
      {msg && <p className={`mt-2 text-sm ${msg.kind === "ok" ? "text-emerald-700" : "text-rose-700"}`}>{msg.text}</p>}
    </div>
  );
}
