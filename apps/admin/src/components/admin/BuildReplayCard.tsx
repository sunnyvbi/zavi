"use client";

import { useEffect, useState } from "react";
import { adminApiFetch } from "@/lib/api-admin";

type ReplayState = { fixture: string; allowed: boolean; fixtures: string[] };

export function BuildReplayCard({ tenantId }: { tenantId: string }) {
  const [state, setState] = useState<ReplayState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setState(null);
    adminApiFetch(`/api/admin/build-replay?tenant_id=${tenantId}`)
      .then(async (res) => {
        const b = await res.json().catch(() => ({}));
        if (!live) return;
        if (!res.ok) setError(b?.error?.message ?? `HTTP ${res.status}`);
        else setState({ fixture: String(b.fixture), allowed: b.allowed === true, fixtures: b.fixtures ?? [] });
      })
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [tenantId]);

  const save = async (next: string) => {
    if (!state) return;
    setBusy(true);
    setError(null);
    try {
      const res = await adminApiFetch(`/api/admin/settings`, {
        method: "PUT",
        body: JSON.stringify({ key: "build_replay_fixture", scope: "tenant", tenant_id: tenantId, value: next }),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(b?.error?.message ?? `HTTP ${res.status}`);
      setState({ ...state, fixture: next });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const canTurnOn = state?.allowed === true;

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">Build replay (dev only)</h3>
          <p className="mt-0.5 text-xs text-slate-500">
            Builds for this tenant reuse a saved build instead of calling the AI. Repo, database, deploy and the ready
            card still run for real. Only a local dev backend honors it.
          </p>
          {state && !canTurnOn && (
            <p className="mt-1 text-xs font-medium text-amber-700">
              This backend is production or staging, so replay cannot be turned on here.
            </p>
          )}
        </div>
        <select
          aria-label="Build replay fixture"
          value={state?.fixture ?? "off"}
          disabled={busy || state === null}
          onChange={(e) => void save(e.target.value)}
          className="shrink-0 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 disabled:opacity-50"
        >
          <option value="off">Off</option>
          {(state?.fixtures ?? []).map((f) => (
            <option key={f} value={f} disabled={!canTurnOn}>
              {f}
            </option>
          ))}
        </select>
      </div>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </div>
  );
}
