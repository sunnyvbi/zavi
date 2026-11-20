"use client";

import { useCallback, useEffect, useState } from "react";
import { adminApiFetch } from "@/lib/api-admin";

type StaffMember = {
  user_id: string;
  email: string | null;
  name: string | null;
  role: string;
  granted_at: string;
  granted_by: string | null;
};
type ListResp = { staff: StaffMember[]; summary: { count: number } };

type Candidate = { user_id: string; email: string | null; name: string | null; is_staff: boolean };

type Pending =
  | { kind: "grant"; user_id: string; label: string }
  | { kind: "revoke"; user_id: string; label: string };

export default function SuperUsersPage() {
  const [data, setData] = useState<ListResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [searching, setSearching] = useState(false);

  const [pending, setPending] = useState<Pending | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    try {
      const res = await adminApiFetch("/api/admin/super-users");
      const r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
      setData(r as ListResp);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    const q = search.trim();
    if (q.length < 2) {
      setCandidates(null);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const res = await adminApiFetch(`/api/admin/super-users/candidates?search=${encodeURIComponent(q)}`);
        const r = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
        if (!cancelled) setCandidates((r.candidates ?? []) as Candidate[]);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [search]);

  const confirmWord = pending?.kind === "grant" ? "GRANT" : "REVOKE";
  const canConfirm = pending != null && confirmText.trim().toUpperCase() === confirmWord && !busy;

  async function runPending() {
    if (!pending || !canConfirm) return;
    setBusy(true);
    try {
      const path = pending.kind === "grant" ? "/api/admin/super-users/grant" : "/api/admin/super-users/revoke";
      const res = await adminApiFetch(path, {
        method: "POST",
        body: JSON.stringify({ user_id: pending.user_id }),
      });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
      setToast(pending.kind === "grant" ? `Granted staff access to ${pending.label}.` : `Revoked ${pending.label}.`);
      setPending(null);
      setConfirmText("");
      setSearch("");
      setCandidates(null);
      await loadList();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function labelFor(email: string | null, name: string | null, id: string): string {
    return email || name || id.slice(0, 8);
  }

  return (
    <div className="max-w-4xl mx-auto p-6">
      <div className="mb-5">
        <div className="text-xs uppercase tracking-[0.2em] text-rose-700">Zavi · admin</div>
        <h1 className="font-display font-semibold text-2xl text-slate-900 mt-1">Super users</h1>
        <p className="text-sm text-slate-500 mt-1">
          Who can reach the admin dashboard. Granting here hands out admin access — it takes effect immediately.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 mb-4 flex items-start justify-between gap-3">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} className="text-rose-500 hover:text-rose-700">
            ✕
          </button>
        </div>
      )}
      {toast && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 mb-4 flex items-start justify-between gap-3">
          <span>{toast}</span>
          <button type="button" onClick={() => setToast(null)} className="text-emerald-600 hover:text-emerald-800">
            ✕
          </button>
        </div>
      )}

      {}
      <div className="rounded-xl border border-slate-200 bg-white mb-6">
        <div className="px-4 py-3 border-b border-slate-100 bg-slate-50">
          <div className="font-display font-semibold text-base text-slate-900">Add a super user</div>
          <div className="text-xs text-slate-500 mt-0.5">
            Search existing accounts by email or name. The person must have signed up first.
          </div>
        </div>
        <div className="p-4">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search email or name…"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-300"
          />
          {search.trim().length >= 2 && (
            <div className="mt-3">
              {searching ? (
                <div className="text-sm text-slate-400">Searching…</div>
              ) : !candidates || candidates.length === 0 ? (
                <div className="text-sm text-slate-400">No matching accounts.</div>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {candidates.map((c) => (
                    <li key={c.user_id} className="flex items-center justify-between py-2">
                      <div className="min-w-0">
                        <div className="text-sm text-slate-800 truncate">
                          {c.email || <span className="text-slate-400">— (no email)</span>}
                          {c.name && <span className="ml-2 text-slate-400">{c.name}</span>}
                        </div>
                        <div className="font-mono text-xs text-slate-400 truncate">{c.user_id}</div>
                      </div>
                      {c.is_staff ? (
                        <span className="text-xs rounded px-2 py-1 bg-slate-100 text-slate-500">Already staff</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setConfirmText("");
                            setPending({ kind: "grant", user_id: c.user_id, label: labelFor(c.email, c.name, c.user_id) });
                          }}
                          className="text-sm rounded-lg bg-slate-900 text-white px-3 py-1.5 hover:bg-slate-700"
                        >
                          Grant access
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>

      {}
      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 bg-slate-50">
          <div className="font-display font-semibold text-base text-slate-900">Current super users</div>
          <span className="font-mono text-sm text-slate-600">{data?.summary.count ?? "—"}</span>
        </div>
        {!data ? (
          <div className="p-6 text-sm text-slate-500">Loading…</div>
        ) : data.staff.length === 0 ? (
          <div className="p-6 text-sm text-slate-500">No staff.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-slate-500 text-xs uppercase tracking-[0.1em]">
              <tr>
                <th className="text-left px-4 py-2">User</th>
                <th className="text-left px-3 py-2">Granted</th>
                <th className="text-right px-4 py-2">Action</th>
              </tr>
            </thead>
            <tbody>
              {data.staff.map((m) => (
                <tr key={m.user_id} className="border-t border-slate-100 hover:bg-slate-50">
                  <td className="px-4 py-2">
                    <div className="text-slate-800">
                      {m.email || <span className="text-slate-400">— (no email)</span>}
                      {m.name && <span className="ml-2 text-slate-400">{m.name}</span>}
                    </div>
                    <div className="font-mono text-xs text-slate-400">{m.user_id}</div>
                  </td>
                  <td className="px-3 py-2 text-slate-500">
                    {new Date(m.granted_at).toLocaleDateString()}
                    {m.granted_by && <span className="text-slate-400"> · by {m.granted_by}</span>}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmText("");
                        setPending({ kind: "revoke", user_id: m.user_id, label: labelFor(m.email, m.name, m.user_id) });
                      }}
                      className="text-sm rounded-lg border border-rose-200 text-rose-700 px-3 py-1.5 hover:bg-rose-50"
                    >
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {}
      {pending && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white shadow-xl border border-slate-200 p-5">
            <h2 className="font-display font-semibold text-lg text-slate-900">
              {pending.kind === "grant" ? "Grant admin access" : "Revoke admin access"}
            </h2>
            <p className="text-sm text-slate-600 mt-2">
              {pending.kind === "grant" ? (
                <>
                  <span className="font-medium text-slate-900">{pending.label}</span> will be able to sign into the admin
                  dashboard immediately.
                </>
              ) : (
                <>
                  <span className="font-medium text-slate-900">{pending.label}</span> will lose admin access on their next
                  request.
                </>
              )}
            </p>
            <p className="text-sm text-slate-500 mt-3">
              Type <span className="font-mono font-semibold text-slate-800">{confirmWord}</span> to confirm.
            </p>
            <input
              type="text"
              value={confirmText}
              autoFocus
              onChange={(e) => setConfirmText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canConfirm) void runPending();
              }}
              className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-300"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setPending(null);
                  setConfirmText("");
                }}
                disabled={busy}
                className="text-sm rounded-lg border border-slate-300 text-slate-700 px-3 py-1.5 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void runPending()}
                disabled={!canConfirm}
                className={
                  "text-sm rounded-lg px-3 py-1.5 text-white " +
                  (pending.kind === "grant" ? "bg-slate-900 hover:bg-slate-700" : "bg-rose-600 hover:bg-rose-500") +
                  (canConfirm ? "" : " opacity-40 cursor-not-allowed")
                }
              >
                {busy ? "Working…" : pending.kind === "grant" ? "Grant access" : "Revoke"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
