"use client";

import { useCallback, useEffect, useState } from "react";
import { adminApiFetch } from "@/lib/api-admin";

type HaltState = {
  halted: boolean;
  updated_at: string | null;
  updated_by: string | null;
  readError: boolean;
};

const UNKNOWN: HaltState = { halted: false, updated_at: null, updated_by: null, readError: true };

export default function AdminFleetHaltPage() {
  const [state, setState] = useState<HaltState | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await adminApiFetch("/api/admin/fleet-halt");
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      setState({
        halted: body.halted === true,
        updated_at: body.updated_at ?? null,
        updated_by: body.updated_by ?? null,
        readError: false,
      });
      setErr(null);
    } catch (e) {
      setState(UNKNOWN);
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function flip(next: boolean) {
    setErr(null);
    setBusy(true);
    try {
      const res = await adminApiFetch("/api/admin/fleet-halt", {
        method: "POST",
        body: JSON.stringify({ halted: next }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error?.message ?? `update failed (${res.status})`);
      setState({
        halted: body.halted === true,
        updated_at: new Date().toISOString(),
        updated_by: null,
        readError: false,
      });
      setConfirmText("");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const canEngage = confirmText.trim().toUpperCase() === "HALT";

  return (
    <div className="max-w-2xl mx-auto p-6">
      <div className="mb-5">
        <div className="text-xs uppercase tracking-[0.2em] text-rose-700">Zavi · admin</div>
        <h1 className="font-display font-semibold text-2xl text-slate-900 mt-1">Fleet panic-stop</h1>
        <p className="text-sm text-slate-500 mt-1">
          Global kill switch. When engaged, NO new agent run enqueues across ANY tenant — manual,
          chat, cron, a2a and webhook wakes are all refused, and the cron scanner skips. The backend
          fails safe: if it can&apos;t read this flag it treats the fleet as halted. Clearing it
          resumes all tenants. Takes effect within seconds; edits are audit-logged.
        </p>
      </div>

      {err && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 mb-4">
          {err}
        </div>
      )}

      {state === null ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : (
        <>
          <div
            className={
              "rounded-xl border-2 p-5 " +
              (state.readError
                ? "border-amber-400 bg-amber-50"
                : state.halted
                  ? "border-rose-400 bg-rose-50"
                  : "border-emerald-300 bg-emerald-50")
            }
          >
            <div className="flex items-center gap-3">
              <span
                className={
                  "inline-block h-3 w-3 rounded-full " +
                  (state.readError ? "bg-amber-500" : state.halted ? "bg-rose-500" : "bg-emerald-500")
                }
                aria-hidden
              />
              <span className="text-lg font-semibold text-slate-900">
                {state.readError
                  ? "STATE UNKNOWN — couldn't read the flag (runtime fails safe to HALTED)"
                  : state.halted
                    ? "FLEET HALTED — all agent runs stopped"
                    : "Fleet running"}
              </span>
            </div>
            {state.readError && (
              <p className="mt-2 text-sm text-amber-800">
                The config store was unreadable. The backend gates treat this as halted, so new runs
                are likely being refused right now. Set an explicit state below.
              </p>
            )}
            {!state.readError && state.updated_at && (
              <p className="mt-2 text-xs text-slate-500">
                last changed: {new Date(state.updated_at).toLocaleString()}
                {state.updated_by ? ` by ${state.updated_by}` : ""}
              </p>
            )}
          </div>

          {state.halted && !state.readError ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void flip(false)}
              className="mt-4 w-full rounded-md bg-emerald-600 px-4 py-3 text-base font-semibold text-white disabled:opacity-50 hover:bg-emerald-700"
            >
              {busy ? "Resuming…" : "Resume fleet"}
            </button>
          ) : (
            <div className="mt-4 space-y-2">
              <label className="block text-sm text-slate-600">
                Type <code className="font-mono font-semibold">HALT</code> to confirm engaging the
                global panic-stop:
              </label>
              <input
                type="text"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder="HALT"
                className="w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-sm"
              />
              <button
                type="button"
                disabled={busy || !canEngage}
                onClick={() => void flip(true)}
                className="w-full rounded-md bg-rose-600 px-4 py-3 text-base font-semibold text-white disabled:opacity-50 hover:bg-rose-700"
              >
                {busy ? "Halting…" : "HALT ALL AGENT RUNS"}
              </button>
              {state.readError && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void flip(false)}
                  className="w-full rounded-md border border-emerald-600 px-4 py-3 text-base font-semibold text-emerald-700 disabled:opacity-50 hover:bg-emerald-50"
                >
                  {busy ? "Resuming…" : "Resume fleet (clear halt)"}
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
