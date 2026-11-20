"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { FLAG_NAME_RE, gatekeeperApi, type CachePolicy, type GatekeeperFlag } from "@/lib/gatekeeper-api";

function when(iso: string): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

export default function GatekeeperPage() {
  const [flags, setFlags] = useState<GatekeeperFlag[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setFlags(await gatekeeperApi.list());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(name: string, fn: () => Promise<unknown>) {
    setBusy(name);
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const q = query.trim().toLowerCase();
  const shown = (flags ?? []).filter(
    (f) => !q || f.name.includes(q) || f.description.toLowerCase().includes(q),
  );
  const enabledCount = (flags ?? []).filter((f) => f.is_enabled).length;

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="mb-5 flex items-end justify-between gap-4 flex-wrap">
        <div>
          <div className="text-xs uppercase tracking-[0.2em] text-rose-700">Zavi · admin</div>
          <h1 className="font-display font-semibold text-2xl text-slate-900 mt-1">Gatekeeper</h1>
          <p className="text-sm text-slate-500 mt-1">
            Per-user feature flags. A flag is on for a user when it is enabled and the user is whitelisted or
            falls inside the rollout %. Logged-out visitors see it only at 100%.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => void load()}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
          >
            Refresh
          </button>
          <button
            onClick={() => setShowCreate((v) => !v)}
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
          >
            {showCreate ? "Cancel" : "New flag"}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 mb-4">{error}</div>
      )}

      {showCreate && (
        <CreateForm
          onCreated={async () => {
            setShowCreate(false);
            await load();
          }}
        />
      )}

      {flags && (
        <div className="flex items-center gap-3 mb-3 flex-wrap">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search flags"
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm w-64"
          />
          <span className="text-sm text-slate-500">
            {flags.length} flags · {enabledCount} enabled
          </span>
        </div>
      )}

      {!flags ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : shown.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
          {flags.length === 0 ? "No flags yet. Create one to start a rollout." : "No flags match your search."}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2">Flag</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Rollout</th>
                <th className="px-3 py-2">Whitelist</th>
                <th className="px-3 py-2">Cache</th>
                <th className="px-3 py-2">Updated</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {shown.map((f) => (
                <tr key={f.name} className="border-t border-slate-100 align-top">
                  <td className="px-3 py-2">
                    <Link href={`/gatekeeper/${encodeURIComponent(f.name)}`} className="font-mono text-slate-900 hover:underline">
                      {f.name}
                    </Link>
                    {f.description && <div className="text-xs text-slate-500 mt-0.5 max-w-md">{f.description}</div>}
                  </td>
                  <td className="px-3 py-2">
                    <button
                      disabled={busy === f.name}
                      onClick={() => void run(f.name, () => gatekeeperApi.setEnabled(f.name, !f.is_enabled))}
                      className={
                        "rounded px-2 py-0.5 text-xs font-medium disabled:opacity-50 " +
                        (f.is_enabled ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-600")
                      }
                      title="Click to toggle"
                    >
                      {f.is_enabled ? "enabled" : "disabled"}
                    </button>
                  </td>
                  <td className="px-3 py-2 tabular-nums">{f.rollout_percentage}%</td>
                  <td className="px-3 py-2 tabular-nums">{f.whitelist.length}</td>
                  <td className="px-3 py-2 text-slate-600">{f.cache_policy}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">
                    {when(f.updated_at)}
                    {f.updated_by && <div>{f.updated_by}</div>}
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <Link href={`/gatekeeper/${encodeURIComponent(f.name)}`} className="text-slate-700 hover:underline mr-3">
                      Edit
                    </Link>
                    {pendingDelete === f.name ? (
                      <>
                        <button
                          disabled={busy === f.name}
                          onClick={() =>
                            void run(f.name, async () => {
                              await gatekeeperApi.remove(f.name);
                              setPendingDelete(null);
                            })
                          }
                          className="text-rose-700 font-medium hover:underline mr-2"
                        >
                          Confirm delete
                        </button>
                        <button onClick={() => setPendingDelete(null)} className="text-slate-500 hover:underline">
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button onClick={() => setPendingDelete(f.name)} className="text-rose-700 hover:underline">
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CreateForm({ onCreated }: { onCreated: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [rollout, setRollout] = useState(0);
  const [cachePolicy, setCachePolicy] = useState<CachePolicy>("standard");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameOk = FLAG_NAME_RE.test(name);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!nameOk) return;
    setSaving(true);
    setError(null);
    try {
      await gatekeeperApi.create(name, {
        description,
        is_enabled: enabled,
        rollout_percentage: rollout,
        cache_policy: cachePolicy,
      });
      await onCreated();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="rounded-lg border border-slate-200 bg-white p-4 mb-5 grid gap-3 max-w-2xl">
      <label className="grid gap-1 text-sm">
        <span className="text-slate-700">Name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value.toLowerCase())}
          placeholder="e.g. new-onboarding-flow"
          className="rounded-md border border-slate-300 px-3 py-1.5 font-mono"
        />
        {name && !nameOk && (
          <span className="text-xs text-rose-700">Lowercase letters, digits, _ . - only (max 80).</span>
        )}
      </label>
      <label className="grid gap-1 text-sm">
        <span className="text-slate-700">Description</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What this flag controls and what ON / OFF means"
          rows={2}
          maxLength={500}
          className="rounded-md border border-slate-300 px-3 py-1.5"
        />
      </label>
      <div className="flex gap-6 flex-wrap items-end">
        <label className="grid gap-1 text-sm">
          <span className="text-slate-700">Rollout: {rollout}%</span>
          <input type="range" min={0} max={100} value={rollout} onChange={(e) => setRollout(Number(e.target.value))} />
        </label>
        <label className="grid gap-1 text-sm">
          <span className="text-slate-700">Cache</span>
          <select
            value={cachePolicy}
            onChange={(e) => setCachePolicy(e.target.value as CachePolicy)}
            className="rounded-md border border-slate-300 px-2 py-1.5"
          >
            <option value="standard">standard (30 min)</option>
            <option value="critical">critical (5 min)</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enabled
        </label>
      </div>
      {error && <div className="text-sm text-rose-700">{error}</div>}
      <div>
        <button
          type="submit"
          disabled={!nameOk || saving}
          className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {saving ? "Creating…" : "Create flag"}
        </button>
      </div>
    </form>
  );
}
