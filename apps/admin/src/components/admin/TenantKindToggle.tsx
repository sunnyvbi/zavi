"use client";

import { useState } from "react";
import { adminApiFetch } from "@/lib/api-admin";

export async function setTenantKind(tenantId: string, next: "real" | "test"): Promise<string> {
  const res = await adminApiFetch(`/api/admin/tenants/${tenantId}/kind`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: next }),
  });
  const r = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
  return r.kind ?? next;
}

export function TenantKindToggle({ tenantId, initialKind }: { tenantId: string; initialKind: string | null }) {
  const [kind, setKind] = useState(initialKind ?? "real");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const next = kind === "test" ? "real" : "test";

  async function flip() {
    setSaving(true);
    setError(null);
    try {
      setKind(await setTenantKind(tenantId, next));
    } catch (e) {
      setError(`Could not mark as ${next}: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  const switchable = kind === "real" || kind === "test";

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span
        className={`rounded px-1.5 py-0.5 text-xs ${kind === "test" ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate-700"}`}
      >
        {kind}
      </span>
      {switchable && (
        <button
          type="button"
          onClick={flip}
          disabled={saving}
          className="rounded border border-slate-300 px-2 py-0.5 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          {saving ? "Saving…" : `Mark as ${next}`}
        </button>
      )}
      {error && <span className="text-xs text-rose-700">{error}</span>}
    </span>
  );
}
