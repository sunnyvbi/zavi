"use client";

import { useCallback, useEffect, useState } from "react";
import { adminApiFetch } from "@/lib/api-admin";

type Tenant = { id: string; slug: string; display_name: string | null };

type LaneState = {
  tenant_id: string;
  enabled: boolean;
  last_drained_at: string | null;
  updated_by: string | null;
  updated_at: string | null;
  master_enabled: boolean;
};

type TokenReveal = {
  tenant_id: string;
  raw_token: string;
  copied: boolean;
};

function agoLabel(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "just now";
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(ms / 60_000))}m ago`;
  if (h < 48) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export default function AdminLocalLanePage() {
  return <Body />;
}

function Body() {
  const [tenants, setTenants] = useState<Tenant[] | null>(null);
  const [laneMap, setLaneMap] = useState<Record<string, LaneState | null>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [busyRows, setBusyRows] = useState<Record<string, boolean>>({});
  const [reveal, setReveal] = useState<TokenReveal | null>(null);

  const masterEnabled: boolean | null = (() => {
    const row = Object.values(laneMap).find((r) => r !== null && r !== undefined);
    return (row as LaneState | undefined)?.master_enabled ?? null;
  })();

  const loadAll = useCallback(async (ts: Tenant[]) => {
    setLaneMap({});
    setLoadError(null);
    setReveal(null);
    try {
      const results = await Promise.all(
        ts.map(async (t) => {
          try {
            const res = await adminApiFetch(
              `/api/admin/local-lane?tenant_id=${encodeURIComponent(t.id)}`,
            );
            const r = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
            return { id: t.id, state: r as LaneState };
          } catch (e) {
            return { id: t.id, state: null, err: (e as Error).message };
          }
        }),
      );
      const map: Record<string, LaneState | null> = {};
      const errs: Record<string, string> = {};
      for (const { id, state, err } of results as {
        id: string;
        state: LaneState | null;
        err?: string;
      }[]) {
        map[id] = state;
        if (err) errs[id] = err;
      }
      setLaneMap(map);
      if (Object.keys(errs).length > 0) setRowErrors(errs);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const res = await adminApiFetch("/api/admin/tenants");
        const r = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
        const ts = (r.tenants ?? []) as Tenant[];
        setTenants(ts);
        await loadAll(ts);
      } catch (e) {
        setLoadError((e as Error).message);
      }
    })();
  }, [loadAll]);

  const reloadOne = useCallback(async (tenantId: string) => {
    try {
      const res = await adminApiFetch(
        `/api/admin/local-lane?tenant_id=${encodeURIComponent(tenantId)}`,
      );
      const r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
      setLaneMap((m) => ({ ...m, [tenantId]: r as LaneState }));
    } catch (e) {
      setRowErrors((errs) => ({ ...errs, [tenantId]: (e as Error).message }));
    }
  }, []);

  async function flip(tenantId: string, enabled: boolean) {
    setBusyRows((b) => ({ ...b, [tenantId]: true }));
    setRowErrors((e) => ({ ...e, [tenantId]: "" }));
    try {
      const res = await adminApiFetch("/api/admin/local-lane", {
        method: "POST",
        body: JSON.stringify({ tenant_id: tenantId, enabled }),
      });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
      await reloadOne(tenantId);
    } catch (e) {
      setRowErrors((errs) => ({ ...errs, [tenantId]: (e as Error).message }));
    } finally {
      setBusyRows((b) => ({ ...b, [tenantId]: false }));
    }
  }

  async function enableOneClick(tenantId: string) {
    setBusyRows((b) => ({ ...b, [tenantId]: true }));
    setRowErrors((e) => ({ ...e, [tenantId]: "" }));
    setReveal(null);
    try {
      const res = await adminApiFetch("/api/admin/local-lane/enable", {
        method: "POST",
        body: JSON.stringify({ tenant_id: tenantId }),
      });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
      await reloadOne(tenantId);
      setReveal({ tenant_id: tenantId, raw_token: r.raw_token as string, copied: false });
    } catch (e) {
      setRowErrors((errs) => ({ ...errs, [tenantId]: (e as Error).message }));
    } finally {
      setBusyRows((b) => ({ ...b, [tenantId]: false }));
    }
  }

  const loading = tenants === null;
  const allLoaded = tenants !== null && Object.keys(laneMap).length === tenants.length;

  return (
    <div className="p-6 max-w-5xl">
      <h1 className="text-xl font-semibold mb-1">Local lane (run-fleet)</h1>
      <p className="text-sm text-gray-500 mb-4">
        Route a tenant&apos;s heavy (expensive) agent work to a laptop running the
        run-fleet skill instead of the cloud e2b lane. Flipping ON means the cloud
        STOPS draining that tenant&apos;s heavy work — only flip ON for a tenant you are
        actively running <code>run-fleet &lt;tenant&gt;</code> for.
      </p>

      {}
      {masterEnabled === false && (
        <div className="mb-4 text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2 text-sm">
          Master switch <code>fleet_local_lane_enabled</code> is <strong>OFF</strong> —
          all per-tenant flags are inert until the master is enabled on the{" "}
          <a href="/settings" className="underline">Settings</a> page.
          Nothing routes locally regardless of the toggles below.
        </div>
      )}

      {loadError && (
        <div className="mb-3 text-sm text-red-600 border border-red-200 bg-red-50 rounded px-3 py-2">
          {loadError}
        </div>
      )}

      {loading && (
        <div className="text-sm text-gray-400">Loading tenants…</div>
      )}

      {!loading && tenants.length === 0 && (
        <div className="text-sm text-gray-400">No tenants found.</div>
      )}

      {!loading && tenants.length > 0 && (
        <div className="border rounded overflow-hidden">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="text-left text-gray-500 text-xs bg-gray-50 border-b">
                <th className="px-4 py-2.5 font-medium">Tenant</th>
                <th className="px-4 py-2.5 font-medium">Lane status</th>
                <th className="px-4 py-2.5 font-medium">Last drained</th>
                <th className="px-4 py-2.5 font-medium">Updated by</th>
                <th className="px-4 py-2.5 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {tenants.map((t) => {
                const state = laneMap[t.id] ?? null;
                const rowLoading = !allLoaded && state === null && !rowErrors[t.id];
                const rowErr = rowErrors[t.id];
                const busy = busyRows[t.id] ?? false;

                return (
                  <tr key={t.id} className="border-t border-gray-100">
                    {}
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900">
                        {t.display_name || t.slug}
                      </div>
                      <div className="text-xs text-gray-400">{t.slug}</div>
                    </td>

                    {}
                    <td className="px-4 py-3">
                      {rowLoading ? (
                        <span className="text-xs text-gray-400">Loading…</span>
                      ) : rowErr && !state ? (
                        <span className="text-xs text-red-600">error</span>
                      ) : state ? (
                        <span
                          className={
                            state.enabled
                              ? "inline-block px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800"
                              : "inline-block px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600"
                          }
                        >
                          {state.enabled ? "Enabled" : "Disabled"}
                        </span>
                      ) : null}
                    </td>

                    {}
                    <td className="px-4 py-3 text-xs text-gray-500 font-mono">
                      {state ? agoLabel(state.last_drained_at) : "—"}
                    </td>

                    {}
                    <td className="px-4 py-3 text-xs text-gray-500 max-w-[160px] truncate">
                      {state?.updated_by ?? "—"}
                    </td>

                    {}
                    <td className="px-4 py-3">
                      {state ? (
                        <div className="flex flex-col gap-1.5">
                          {rowErr && (
                            <div className="text-xs text-red-600 mb-1">{rowErr}</div>
                          )}
                          <div className="flex gap-2 flex-wrap">
                            {state.enabled ? (
                              <button
                                className="px-2.5 py-1 text-xs rounded border border-gray-300 text-gray-700 disabled:opacity-40"
                                onClick={() => void flip(t.id, false)}
                                disabled={busy}
                              >
                                {busy ? "…" : "Disable"}
                              </button>
                            ) : (
                              <>
                                <button
                                  className="px-2.5 py-1 text-xs rounded bg-blue-600 text-white disabled:opacity-40"
                                  onClick={() => void enableOneClick(t.id)}
                                  disabled={busy}
                                >
                                  {busy ? "…" : "Enable Mac lane"}
                                </button>
                                <button
                                  className="px-2.5 py-1 text-xs rounded border border-gray-300 text-gray-700 disabled:opacity-40"
                                  onClick={() => void flip(t.id, true)}
                                  disabled={busy}
                                >
                                  {busy ? "…" : "Turn ON (no new token)"}
                                </button>
                              </>
                            )}
                          </div>
                          {}
                          {reveal?.tenant_id === t.id && (
                            <div className="mt-2 text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2 max-w-lg">
                              <div className="font-semibold text-xs">
                                Copy this token now — it is shown ONCE and can never be
                                retrieved again.
                              </div>
                              <code className="block break-all mt-1.5 text-xs bg-white border rounded px-2 py-1 select-all">
                                {reveal.raw_token}
                              </code>
                              <div className="mt-2 flex gap-2">
                                <button
                                  className="px-2.5 py-1 text-xs rounded border border-gray-300 text-gray-700"
                                  onClick={() => {
                                    void navigator.clipboard.writeText(reveal.raw_token);
                                    setReveal((r) => (r ? { ...r, copied: true } : null));
                                    setTimeout(
                                      () =>
                                        setReveal((r) =>
                                          r ? { ...r, copied: false } : null,
                                        ),
                                      2000,
                                    );
                                  }}
                                >
                                  {reveal.copied ? "Copied" : "Copy"}
                                </button>
                                <button
                                  className="px-2.5 py-1 text-xs rounded border border-gray-300 text-gray-700"
                                  onClick={() => setReveal(null)}
                                >
                                  I&apos;ve saved it
                                </button>
                              </div>
                            </div>
                          )}
                          {state.enabled && agoLabel(state.last_drained_at) === "never" && (
                            <div className="text-xs text-amber-700 mt-0.5">
                              ON but never drained — heavy work is piling up. Run{" "}
                              <code>run-fleet {t.slug}</code> or Disable.
                            </div>
                          )}
                        </div>
                      ) : rowLoading ? null : (
                        <span className="text-xs text-gray-400">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
