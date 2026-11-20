"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { adminApiFetch } from "@/lib/api-admin";
import {
  UUID_RE,
  gatekeeperApi,
  type CachePolicy,
  type CheckResult,
  type GatekeeperFlag,
} from "@/lib/gatekeeper-api";

async function resolveUserId(input: string): Promise<string> {
  const v = input.trim();
  if (UUID_RE.test(v)) return v.toLowerCase();
  if (!v.includes("@")) throw new Error("Enter a user id (uuid) or an email.");
  const res = await adminApiFetch(`/api/admin/user-lookup?email=${encodeURIComponent(v)}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message ?? `No user found for ${v} — paste their user id instead.`);
  return String(body.user_id).toLowerCase();
}

const REASON_TEXT: Record<string, string> = {
  not_found: "Flag does not exist",
  disabled: "Flag is disabled",
  whitelisted: "User is whitelisted",
  in_rollout: "User is inside the rollout %",
  not_in_rollout: "User is outside the rollout %",
  anonymous_not_full_rollout: "Logged-out visitors need 100% rollout",
};

export default function GatekeeperFlagPage() {
  const params = useParams();
  const router = useRouter();
  const name = decodeURIComponent(String(params.name));

  const [flag, setFlag] = useState<GatekeeperFlag | null>(null);
  const [draft, setDraft] = useState<GatekeeperFlag | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [userInput, setUserInput] = useState("");
  const [testInput, setTestInput] = useState("");
  const [testResult, setTestResult] = useState<CheckResult | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(async () => {
    try {
      const f = await gatekeeperApi.get(name);
      setFlag(f);
      setDraft(f);
      setError(null);
    } catch (e) {
      const msg = (e as Error).message;
      if (/not found/i.test(msg)) setNotFound(true);
      else setError(msg);
    }
  }, [name]);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty =
    !!flag &&
    !!draft &&
    (flag.description !== draft.description ||
      flag.is_enabled !== draft.is_enabled ||
      flag.rollout_percentage !== draft.rollout_percentage ||
      flag.cache_policy !== draft.cache_policy ||
      flag.whitelist.join(",") !== draft.whitelist.join(","));

  async function save() {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const f = await gatekeeperApi.update(name, {
        description: draft.description,
        is_enabled: draft.is_enabled,
        rollout_percentage: draft.rollout_percentage,
        cache_policy: draft.cache_policy,
        whitelist: draft.whitelist,
      });
      setFlag(f);
      setDraft(f);
      setSavedAt(Date.now());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function addUser() {
    if (!draft || !userInput.trim()) return;
    try {
      const id = await resolveUserId(userInput);
      if (!draft.whitelist.includes(id)) setDraft({ ...draft, whitelist: [...draft.whitelist, id] });
      setUserInput("");
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function runCheck() {
    if (!testInput.trim()) return;
    try {
      setTestResult(await gatekeeperApi.check(name, await resolveUserId(testInput)));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function remove() {
    try {
      await gatekeeperApi.remove(name);
      router.push("/gatekeeper");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const back = (
    <Link href="/gatekeeper" className="text-sm text-slate-600 hover:underline">
      ← All flags
    </Link>
  );

  if (notFound) {
    return (
      <div className="max-w-3xl mx-auto p-6">
        {back}
        <p className="mt-4 text-sm text-slate-600">
          No flag named <span className="font-mono">{name}</span>.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto p-6">
      {back}
      <div className="mt-3 mb-5 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="text-xs uppercase tracking-[0.2em] text-rose-700">Gatekeeper flag</div>
          <h1 className="font-mono font-semibold text-2xl text-slate-900 mt-1">{name}</h1>
          {flag?.updated_by && (
            <p className="text-xs text-slate-500 mt-1">
              Last edited by {flag.updated_by} · {new Date(flag.updated_at).toLocaleString()}
            </p>
          )}
        </div>
        {flag &&
          (confirmDelete ? (
            <div className="flex gap-2">
              <button onClick={() => void remove()} className="rounded-md bg-rose-700 px-3 py-1.5 text-sm text-white">
                Confirm delete
              </button>
              <button onClick={() => setConfirmDelete(false)} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm">
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              className="rounded-md border border-rose-300 px-3 py-1.5 text-sm text-rose-700 hover:bg-rose-50"
            >
              Delete flag
            </button>
          ))}
      </div>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 mb-4">{error}</div>
      )}

      {!draft ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : (
        <div className="grid gap-5">
          <section className="rounded-lg border border-slate-200 bg-white p-4 grid gap-3">
            <h2 className="text-sm font-semibold text-slate-900">Settings</h2>
            <label className="grid gap-1 text-sm">
              <span className="text-slate-700">Description</span>
              <textarea
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                placeholder="What this flag controls and what ON / OFF means"
                rows={2}
                maxLength={500}
                className="rounded-md border border-slate-300 px-3 py-1.5"
              />
            </label>
            <div className="flex gap-6 flex-wrap items-end">
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={draft.is_enabled}
                  onChange={(e) => setDraft({ ...draft, is_enabled: e.target.checked })}
                />
                Enabled
              </label>
              <label className="grid gap-1 text-sm">
                <span className="text-slate-700">Rollout: {draft.rollout_percentage}%</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={draft.rollout_percentage}
                  onChange={(e) => setDraft({ ...draft, rollout_percentage: Number(e.target.value) })}
                />
              </label>
              <label className="grid gap-1 text-sm">
                <span className="text-slate-700">Cache</span>
                <select
                  value={draft.cache_policy}
                  onChange={(e) => setDraft({ ...draft, cache_policy: e.target.value as CachePolicy })}
                  className="rounded-md border border-slate-300 px-2 py-1.5"
                >
                  <option value="standard">standard (30 min)</option>
                  <option value="critical">critical (5 min)</option>
                </select>
              </label>
            </div>
          </section>

          <section className="rounded-lg border border-slate-200 bg-white p-4 grid gap-3">
            <h2 className="text-sm font-semibold text-slate-900">
              Whitelist <span className="font-normal text-slate-500">({draft.whitelist.length} users, always on while enabled)</span>
            </h2>
            <div className="flex gap-2">
              <input
                value={userInput}
                onChange={(e) => setUserInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void addUser()}
                placeholder="User id or email"
                className="flex-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm"
              />
              <button onClick={() => void addUser()} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50">
                Add
              </button>
            </div>
            {draft.whitelist.length > 0 && (
              <ul className="divide-y divide-slate-100 rounded-md border border-slate-100">
                {draft.whitelist.map((id) => (
                  <li key={id} className="flex items-center justify-between px-3 py-1.5 text-sm">
                    <span className="font-mono text-slate-800">{id}</span>
                    <button
                      onClick={() => setDraft({ ...draft, whitelist: draft.whitelist.filter((w) => w !== id) })}
                      className="text-rose-700 hover:underline text-xs"
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <div className="flex items-center gap-3">
            <button
              onClick={() => void save()}
              disabled={!dirty || saving}
              className="rounded-md bg-slate-900 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save changes"}
            </button>
            {dirty && <span className="text-xs text-amber-700">Unsaved changes</span>}
            {!dirty && savedAt && <span className="text-xs text-emerald-700">Saved</span>}
          </div>

          <section className="rounded-lg border border-slate-200 bg-white p-4 grid gap-3">
            <h2 className="text-sm font-semibold text-slate-900">Check a user</h2>
            <p className="text-xs text-slate-500">Uses the saved flag, not unsaved edits above.</p>
            <div className="flex gap-2">
              <input
                value={testInput}
                onChange={(e) => setTestInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void runCheck()}
                placeholder="User id or email"
                className="flex-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm"
              />
              <button onClick={() => void runCheck()} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50">
                Check
              </button>
            </div>
            {testResult && (
              <div
                className={
                  "rounded-md p-3 text-sm " +
                  (testResult.enabled ? "bg-emerald-50 text-emerald-900" : "bg-slate-50 text-slate-700")
                }
              >
                <div className="font-medium">{testResult.enabled ? "ON" : "OFF"} for {testResult.user_id}</div>
                <div>{REASON_TEXT[testResult.reason] ?? testResult.reason}</div>
                {testResult.bucket !== null && (
                  <div className="text-xs mt-1 opacity-75">
                    Rollout bucket {testResult.bucket} (on when bucket &lt; rollout %)
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
