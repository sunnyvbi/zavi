"use client";

import { useCallback, useEffect, useState } from "react";
import { adminApiFetch } from "@/lib/api-admin";
import {
  SecretSettingCard,
  type SaveGlobal,
  type SecretEntry,
} from "@/components/admin/settings/SecretSettingCard";

type SettingType = "boolean" | "number" | "string" | "json";
type SettingScope = "global" | "per-tenant";

type SettingRow = {
  key: string;
  description: string;
  type: SettingType;
  scope: SettingScope;
  defaultValue: unknown;
  globalValue: unknown;
  tenantOverrides: Array<{ tenant_id: string; value: unknown }>;
  options?: string[];
  secret?: boolean;
  secretItems?: string[];
  secretEntries?: SecretEntry[];
  notesAvailable?: boolean;
  secretRevision?: string | null;
};

function fmt(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export default function AdminSettingsPage() {
  return <Body />;
}

function Body() {
  const [rows, setRows] = useState<SettingRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await adminApiFetch("/api/admin/settings");
      const r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
      setRows((r.settings ?? []) as SettingRow[]);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const saveGlobal = useCallback<SaveGlobal>(
    async (key, value, op, extra) => {
      setError(null);
      setNotice(null);
      try {
        const res = await adminApiFetch("/api/admin/settings", {
          method: "PUT",
          body: JSON.stringify({ key, scope: "global", value, ...(op ? { op } : {}), ...(extra ?? {}) }),
        });
        const r = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
        setNotice(typeof r.count === "number" ? `Saved ${key} (${r.count} in pool).` : `Saved ${key}.`);
        await load();
        return true;
      } catch (e) {
        setError(`${key}: ${(e as Error).message}`);
        return false;
      }
    },
    [load],
  );

  return (
    <div className="p-6 max-w-5xl">
      <h1 className="text-xl font-semibold mb-1">App settings</h1>
      <p className="text-sm text-gray-600 mb-4">
        Typed platform settings. Edits write the <strong>global</strong> value (the
        platform default), validated against the registry and audit-logged. Per-tenant
        overrides show as a count; some keys have dedicated per-tenant pages.
      </p>

      {error && (
        <div className="mb-3 text-red-800 bg-red-50 border border-red-200 rounded px-3 py-2 text-sm">
          {error}
        </div>
      )}
      {notice && (
        <div className="mb-3 text-green-800 bg-green-50 border border-green-200 rounded px-3 py-2 text-sm">
          {notice}
        </div>
      )}

      {rows === null && !error && <div className="text-sm text-gray-500">Loading…</div>}

      {rows && (
        <div className="space-y-3">
          {}
          {[...rows].sort((a, b) => Number(!!b.secret) - Number(!!a.secret)).map((row) =>
            row.secret ? (
              <SecretSettingCard key={row.key} row={row} onSaveGlobal={saveGlobal} />
            ) : (
              <SettingCard key={row.key} row={row} onSaveGlobal={saveGlobal} />
            ),
          )}
        </div>
      )}
    </div>
  );
}

function SettingCard({
  row,
  onSaveGlobal,
}: {
  row: SettingRow;
  onSaveGlobal: SaveGlobal;
}) {
  const [draft, setDraft] = useState<string>(
    row.type === "json" ? JSON.stringify(row.globalValue ?? row.defaultValue ?? {}, null, 2) : fmt(row.globalValue),
  );
  const [boolVal, setBoolVal] = useState<boolean>(Boolean(row.globalValue));
  const [busy, setBusy] = useState(false);
  const [localErr, setLocalErr] = useState<string | null>(null);

  async function save() {
    setLocalErr(null);
    setBusy(true);
    try {
      let value: unknown;
      if (row.type === "boolean") value = boolVal;
      else if (row.type === "number") {
        const n = Number(draft);
        if (Number.isNaN(n)) throw new Error("not a number");
        value = n;
      } else if (row.type === "json") {
        value = JSON.parse(draft);
      } else {
        value = draft;
      }
      await onSaveGlobal(row.key, value);
    } catch (e) {
      setLocalErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border rounded p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <code className="text-sm font-semibold">{row.key}</code>
            <span className="text-sm uppercase tracking-wide text-gray-500 border rounded px-1.5 py-0.5">
              {row.type}
            </span>
            <span className="text-sm uppercase tracking-wide text-gray-500 border rounded px-1.5 py-0.5">
              {row.scope}
            </span>
            {row.tenantOverrides.length > 0 && (
              <span className="text-sm text-blue-700 border border-blue-200 bg-blue-50 rounded px-1.5 py-0.5">
                {row.tenantOverrides.length} tenant override
                {row.tenantOverrides.length === 1 ? "" : "s"}
              </span>
            )}
          </div>
          <p className="text-sm text-gray-600 mt-1">{row.description}</p>
          <p className="text-sm text-gray-400 mt-1">default: {fmt(row.defaultValue)}</p>
        </div>

        <div className="shrink-0 flex items-start gap-2">
          {row.type === "boolean" ? (
            <select
              className="border rounded px-2 py-1 text-sm"
              value={boolVal ? "true" : "false"}
              onChange={(e) => setBoolVal(e.target.value === "true")}
              disabled={busy}
            >
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          ) : row.type === "string" && row.options && row.options.length > 0 ? (
            <select
              className="border rounded px-2 py-1 text-sm"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              disabled={busy}
            >
              {row.options.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          ) : row.type === "json" ? (
            <textarea
              className="border rounded px-2 py-1 text-xs font-mono w-72 h-24"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              disabled={busy}
            />
          ) : (
            <input
              className="border rounded px-2 py-1 text-sm w-48"
              type={row.type === "number" ? "number" : "text"}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              disabled={busy}
            />
          )}
          <button
            className="border rounded px-3 py-1 text-sm bg-gray-900 text-white disabled:opacity-50"
            onClick={() => void save()}
            disabled={busy}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
      {localErr && <div className="text-xs text-red-700 mt-2">{localErr}</div>}
    </div>
  );
}
