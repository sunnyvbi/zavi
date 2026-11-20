"use client";

import { useEffect, useState } from "react";
import { adminApiFetch } from "@/lib/api-admin";

type Status = "received" | "working" | "done" | "wont_do";

type Row = {
  id: string;
  company: string;
  sender: string;
  body: string;
  attachment_count: number;
  created_at: string;
  status: Status;
  staff_note: string | null;
};

const STATUS_LABEL: Record<Status, string> = {
  received: "Received",
  working: "Working on it",
  done: "Done",
  wont_do: "Not planned",
};

export function ProductFeedback() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await adminApiFetch("/api/admin/product-feedback");
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
        if (!cancelled) setRows((body.feedback ?? []) as Row[]);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="mt-6">
      <h2 className="font-display text-lg font-semibold text-slate-900">Product feedback</h2>
      <p className="mt-1 text-sm text-slate-600">
        What people sent from Send feedback. Done or Not planned emails them; Working on it shows only in the app.
      </p>
      {error && (
        <div className="mt-3 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</div>
      )}
      {rows === null && !error ? (
        <div className="mt-4 text-sm text-slate-500">Loading…</div>
      ) : rows && rows.length === 0 ? (
        <div className="mt-4 glass-card border-dashed p-6 text-center text-sm text-slate-500">No product feedback yet.</div>
      ) : (
        <div className="mt-4 space-y-2">
          {(rows ?? []).map((r) => (
            <FeedbackRow key={r.id} row={r} />
          ))}
        </div>
      )}
    </section>
  );
}

function FeedbackRow({ row }: { row: Row }) {
  const [status, setStatus] = useState<Status>(row.status);
  const [note, setNote] = useState(row.staff_note ?? "");
  const [saved, setSaved] = useState({ status: row.status, note: row.staff_note ?? "" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const dirty = status !== saved.status || note.trim() !== saved.note.trim();

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await adminApiFetch(`/api/admin/product-feedback/${row.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status, staff_note: note.trim() || null }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      setSaved({ status, note: note.trim() });
      setMsg({ ok: true, text: body.emailed ? "Saved. Emailed the sender." : "Saved." });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-md border border-slate-200 bg-white p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2 text-slate-500">
        <span>{new Date(row.created_at).toLocaleString()}</span>
        <span className="text-slate-400">·</span>
        <span className="text-slate-700">{row.company}</span>
        <span className="text-slate-400">·</span>
        <span>{row.sender}</span>
        {row.attachment_count > 0 && (
          <>
            <span className="text-slate-400">·</span>
            <span>
              {row.attachment_count} attachment{row.attachment_count === 1 ? "" : "s"}
            </span>
          </>
        )}
      </div>
      <p className="mt-1 whitespace-pre-line text-slate-800">{row.body}</p>
      <div className="mt-2 flex flex-wrap items-start gap-2">
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as Status)}
          className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
          aria-label="Status"
        >
          {(Object.keys(STATUS_LABEL) as Status[]).map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        <label className="min-w-[260px] flex-1">
          <span className="block text-xs text-slate-500">Note to customer (they see this)</span>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={2000}
            rows={2}
            className="mt-0.5 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          />
        </label>
        <button
          type="button"
          onClick={() => void save()}
          disabled={!dirty || busy}
          className="self-end rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
      {msg && <p className={`mt-1 text-xs ${msg.ok ? "text-emerald-700" : "text-rose-700"}`}>{msg.text}</p>}
    </div>
  );
}
