"use client";

import { useCallback, useEffect, useState } from "react";
import { adminApiFetch } from "@/lib/api-admin";

type Shard = {
  id: string;
  name: string;
  state: string;
  region: string | null;
  is_canary: boolean;
  provision_step: string | null;
  site_count: number;
  max_sites: number;
  load: number;
  metrics: Record<string, number | null>;
  metrics_at: string | null;
};

type Attempt = { id: string; kind: string; source: string; shard_name: string; status: string; reason: string | null; created_at: string; cap_override: boolean; actor: string | null };

type Data = {
  env: string;
  deployed_backend: boolean;
  settings: { enabled: boolean; thresholdPct: number; maxPerDay: number; region: string; dryRun: boolean };
  headroom: number;
  open: number;
  auto: { paused: boolean; paused_reason: string | null; consecutive_failures: number };
  created_today: number;
  attempts: Attempt[];
  prereqs_missing: string[];
  shards: Shard[];
};

const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;

export default function AdminSiteShardsPage() {
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [override, setOverride] = useState(false);
  const [reason, setReason] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await adminApiFetch("/api/admin/site-shards");
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      setData(body as Data);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function post(path: string, body: unknown, done: (b: Record<string, unknown>) => string) {
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      const res = await adminApiFetch(path, { method: "POST", body: JSON.stringify(body) });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(b?.error?.message ?? `HTTP ${res.status}`);
      setNote(done(b));
      setOverride(false);
      setReason("");
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const createNow = () =>
    post("/api/admin/site-shards/provision", override ? { override_cap: true, reason } : {}, (b) =>
      b.action === "dry_run" ? `Dry run: would ${String(b.would)}` : `${b.action === "resume" ? "Resuming" : "Creating"} ${String(b.shard_name)}. Watch the attempts below.`,
    );
  const setPaused = (paused: boolean) =>
    post("/api/admin/site-shards/auto-provisioning", { paused }, () => (paused ? "Auto-provisioning paused." : "Auto-provisioning resumed (breaker reset)."));

  return (
    <div className="max-w-5xl mx-auto p-6">
      <div className="mb-5">
        <div className="text-xs uppercase tracking-[0.2em] text-sky-700">Zavi · admin</div>
        <h1 className="font-display font-semibold text-2xl text-slate-900 mt-1">Site shards</h1>
        <p className="text-sm text-slate-500 mt-1">
          Shared site databases. Each one is a paid Supabase project (about $10/month). New ones are created
          automatically when headroom runs low, at most {data?.settings.maxPerDay ?? 10} a day, with an alert every time.
        </p>
      </div>

      {err && <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 mb-4">{err}</div>}
      {note && <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 mb-4">{note}</div>}

      {!data ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
            <Stat label={`Open headroom (${data.env})`} value={pct(data.headroom)} hint={`create below ${data.settings.thresholdPct}%`} warn={data.headroom < data.settings.thresholdPct / 100} />
            <Stat label="Open shards" value={String(data.open)} warn={data.open === 0} />
            <Stat label="Created today (UTC)" value={`${data.created_today} / ${data.settings.maxPerDay}`} />
            <Stat
              label="Auto-provisioning"
              value={!data.settings.enabled ? "OFF (setting)" : data.auto.paused ? "PAUSED" : data.settings.dryRun ? "DRY RUN" : "ON"}
              hint={data.auto.paused ? data.auto.paused_reason ?? "" : `failures in a row: ${data.auto.consecutive_failures}`}
              warn={!data.settings.enabled || data.auto.paused}
            />
          </div>

          {!data.deployed_backend && (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 mb-4">
              This backend is not the deployed production container, so it never creates shards.
            </div>
          )}
          {data.prereqs_missing.length > 0 && (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 mb-4">
              Provisioning cannot run, missing: {data.prereqs_missing.join(", ")}
            </div>
          )}

          <div className="rounded-xl border border-slate-200 p-4 mb-5 flex flex-wrap items-center gap-3">
            <button
              className="rounded-md bg-sky-700 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
              disabled={busy || (override && reason.trim().length < 3)}
              onClick={createNow}
            >
              Create shared database now
            </button>
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} />
              override the daily cap
            </label>
            {override && (
              <input
                className="rounded-md border border-slate-300 px-2 py-1 text-sm w-64"
                placeholder="reason (audited)"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            )}
            <span className="flex-1" />
            {data.auto.paused ? (
              <button className="rounded-md border border-emerald-400 px-3 py-2 text-sm text-emerald-800" disabled={busy} onClick={() => setPaused(false)}>
                Resume auto-provisioning
              </button>
            ) : (
              <button className="rounded-md border border-rose-300 px-3 py-2 text-sm text-rose-800" disabled={busy} onClick={() => setPaused(true)}>
                Pause auto-provisioning
              </button>
            )}
          </div>

          <h2 className="text-sm font-semibold text-slate-800 mb-2">Shards</h2>
          <div className="overflow-x-auto mb-6">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-slate-500">
                <tr>
                  <th className="py-1 pr-3">Name</th>
                  <th className="py-1 pr-3">State</th>
                  <th className="py-1 pr-3">Load</th>
                  <th className="py-1 pr-3">Sites</th>
                  <th className="py-1 pr-3">Records</th>
                  <th className="py-1 pr-3">Auth users</th>
                  <th className="py-1 pr-3">Sessions</th>
                  <th className="py-1 pr-3">Email/h</th>
                  <th className="py-1 pr-3">Step</th>
                </tr>
              </thead>
              <tbody>
                {data.shards.length === 0 && (
                  <tr>
                    <td colSpan={9} className="py-2 text-slate-500">No shards yet.</td>
                  </tr>
                )}
                {data.shards.map((s) => (
                  <tr key={s.id} className="border-t border-slate-100">
                    <td className="py-1 pr-3 font-mono">{s.name}{s.is_canary ? " (canary)" : ""}</td>
                    <td className="py-1 pr-3">{s.state}</td>
                    <td className="py-1 pr-3">{pct(s.load)}</td>
                    <td className="py-1 pr-3">{s.site_count} / {s.max_sites}</td>
                    <td className="py-1 pr-3">{s.metrics.records ?? "-"}</td>
                    <td className="py-1 pr-3">{s.metrics.auth_users ?? "-"}</td>
                    <td className="py-1 pr-3">{s.metrics.sessions ?? "-"}</td>
                    <td className="py-1 pr-3">{s.metrics.emails_per_hour ?? "-"}</td>
                    <td className="py-1 pr-3">{s.provision_step ?? "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h2 className="text-sm font-semibold text-slate-800 mb-2">Recent provisioning attempts</h2>
          <ul className="text-sm space-y-1">
            {data.attempts.length === 0 && <li className="text-slate-500">None yet.</li>}
            {data.attempts.map((a) => (
              <li key={a.id} className="text-slate-700">
                <span className="text-slate-400">{new Date(a.created_at).toLocaleString()}</span> · {a.kind} {a.shard_name} ({a.source}
                {a.actor ? ` ${a.actor}` : ""}
                {a.cap_override ? ", cap override" : ""}) · <b>{a.status}</b>
                {a.reason ? ` · ${a.reason}` : ""}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, hint, warn }: { label: string; value: string; hint?: string; warn?: boolean }) {
  return (
    <div className={"rounded-xl border p-3 " + (warn ? "border-amber-300 bg-amber-50" : "border-slate-200")}>
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-lg font-semibold text-slate-900">{value}</div>
      {hint && <div className="text-xs text-slate-500 truncate">{hint}</div>}
    </div>
  );
}
