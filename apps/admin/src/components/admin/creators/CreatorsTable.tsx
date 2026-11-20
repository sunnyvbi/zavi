"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { adminApiFetch } from "@/lib/api-admin";

export type CreatorRow = {
  id: string;
  display_name: string;
  slug?: string | null;
  city?: string | null;
  country_code?: string | null;
  vetting_state: "pending" | "under_review" | "approved" | "rejected";
  rejected_reason: string | null;
  created_at: string;
};

export const FILTERS = [
  { key: "approved", label: "Live" },
  { key: "pending", label: "Pending" },
  { key: "rejected", label: "Disabled" },
  { key: "all", label: "All" },
] as const;
export type FilterKey = (typeof FILTERS)[number]["key"];

export const PAGE_SIZE = 100;
export const DEFAULT_DISABLE_REASON = "Test creator";

export function queuePath(filter: FilterKey, offset: number): string {
  const p = new URLSearchParams({
    discipline: "ugc_creator",
    sort: "newest",
    limit: String(PAGE_SIZE),
    offset: String(offset),
  });
  if (filter !== "all") p.set("vetting_state", filter);
  return `/api/admin/humans?${p.toString()}`;
}

function stateLabel(s: CreatorRow["vetting_state"]): string {
  return s === "approved" ? "live" : s === "rejected" ? "disabled" : s.replace(/_/g, " ");
}

export function CreatorsRows({
  rows,
  confirmingId,
  reason,
  busyId,
  onDisable,
  onReasonChange,
  onConfirm,
  onCancel,
}: {
  rows: CreatorRow[];
  confirmingId: string | null;
  reason: string;
  busyId: string | null;
  onDisable: (id: string) => void;
  onReasonChange: (v: string) => void;
  onConfirm: (id: string) => void;
  onCancel: () => void;
}) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs uppercase tracking-wide text-slate-500 border-b border-slate-200">
          <th className="py-2 pr-3 font-medium">Creator</th>
          <th className="py-2 pr-3 font-medium">Location</th>
          <th className="py-2 pr-3 font-medium">Joined</th>
          <th className="py-2 pr-3 font-medium">Status</th>
          <th className="py-2 font-medium text-right">Action</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((c) => {
          const disabled = c.vetting_state === "rejected";
          const confirming = confirmingId === c.id;
          return (
            <tr key={c.id} className="border-b border-slate-100 align-top">
              <td className="py-2 pr-3">
                <Link href={`/creator-network/creators/${c.id}`} className="font-medium text-slate-900 hover:underline">
                  {c.display_name}
                </Link>
                {c.slug && <div className="text-xs text-slate-500">/{c.slug}</div>}
              </td>
              <td className="py-2 pr-3 text-slate-600">
                {[c.city, c.country_code].filter(Boolean).join(", ") || "—"}
              </td>
              <td className="py-2 pr-3 text-slate-600">{new Date(c.created_at).toLocaleDateString()}</td>
              <td className="py-2 pr-3">
                <span
                  className={
                    disabled
                      ? "rounded bg-slate-100 text-slate-600 px-2 py-0.5 text-xs"
                      : c.vetting_state === "approved"
                        ? "rounded bg-emerald-100 text-emerald-900 px-2 py-0.5 text-xs"
                        : "rounded bg-amber-100 text-amber-900 px-2 py-0.5 text-xs"
                  }
                >
                  {stateLabel(c.vetting_state)}
                </span>
                {disabled && c.rejected_reason && (
                  <div className="text-xs text-slate-500 mt-1">{c.rejected_reason}</div>
                )}
              </td>
              <td className="py-2 text-right">
                {disabled ? null : confirming ? (
                  <div className="flex items-center justify-end gap-2">
                    <input
                      aria-label="Reason"
                      value={reason}
                      onChange={(e) => onReasonChange(e.target.value)}
                      className="w-40 rounded border border-slate-300 px-2 py-1 text-xs"
                    />
                    <button
                      type="button"
                      disabled={busyId === c.id || reason.trim().length === 0}
                      onClick={() => onConfirm(c.id)}
                      className="rounded bg-rose-600 text-white px-2 py-1 text-xs disabled:opacity-50"
                    >
                      {busyId === c.id ? "Disabling…" : "Confirm"}
                    </button>
                    <button type="button" onClick={onCancel} className="text-xs text-slate-500 hover:underline">
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => onDisable(c.id)}
                    className="rounded border border-rose-300 text-rose-700 px-2 py-1 text-xs hover:bg-rose-50"
                  >
                    Disable
                  </button>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function CreatorsTable() {
  const [filter, setFilter] = useState<FilterKey>("approved");
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<CreatorRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [reason, setReason] = useState(DEFAULT_DISABLE_REASON);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  const latest = useRef(0);

  const load = useCallback(async () => {
    const seq = ++latest.current;
    setError(null);
    try {
      const res = await adminApiFetch(queuePath(filter, offset));
      const r = await res.json().catch(() => ({}));
      if (seq !== latest.current) return;
      if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
      const items = (r.items ?? []) as CreatorRow[];
      if (items.length === 0 && offset > 0) {
        setOffset(Math.max(0, offset - PAGE_SIZE));
        return;
      }
      setRows(items);
      setTotal(Number(r.total ?? 0));
    } catch (e) {
      if (seq === latest.current) setError((e as Error).message);
    }
  }, [filter, offset]);

  useEffect(() => {
    setRows(null);
    void load();
  }, [load, reloadTick]);

  async function disable(id: string) {
    setBusyId(id);
    setError(null);
    try {
      const res = await adminApiFetch(`/api/admin/creators/${id}/remove`, {
        method: "POST",
        body: JSON.stringify({ reason: reason.trim() }),
      });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
      setConfirmingId(null);
      setReason(DEFAULT_DISABLE_REASON);
      setReloadTick((t) => t + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-4">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => {
              setFilter(f.key);
              setOffset(0);
              setConfirmingId(null);
            }}
            className={
              filter === f.key
                ? "rounded-full bg-slate-900 text-white px-3 py-1 text-xs"
                : "rounded-full border border-slate-300 text-slate-700 px-3 py-1 text-xs hover:bg-slate-50"
            }
          >
            {f.label}
          </button>
        ))}
        <span className="ml-auto text-xs text-slate-500">{rows ? `${total} creators` : ""}</span>
      </div>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 mb-4">{error}</div>
      )}

      {!rows ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-sm text-slate-600 text-center">
          No creators here.
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-white p-4 overflow-x-auto">
          <CreatorsRows
            rows={rows}
            confirmingId={confirmingId}
            reason={reason}
            busyId={busyId}
            onDisable={(id) => {
              setConfirmingId(id);
              setReason(DEFAULT_DISABLE_REASON);
            }}
            onReasonChange={setReason}
            onConfirm={(id) => void disable(id)}
            onCancel={() => setConfirmingId(null)}
          />
          {total > PAGE_SIZE && (
            <div className="flex items-center justify-end gap-3 mt-3 text-xs text-slate-600">
              <button
                type="button"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                className="hover:underline disabled:opacity-40"
              >
                Previous
              </button>
              <span>
                {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
              </span>
              <button
                type="button"
                disabled={offset + PAGE_SIZE >= total}
                onClick={() => setOffset(offset + PAGE_SIZE)}
                className="hover:underline disabled:opacity-40"
              >
                Next
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
