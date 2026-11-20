"use client";

import { useEffect, useState } from "react";
import { adminApiFetch } from "@/lib/api-admin";

export function CgoAutopilotCard({ tenantId }: { tenantId: string }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setEnabled(null);
    adminApiFetch(`/api/admin/cgo-autopilot?tenant_id=${tenantId}`)
      .then(async (res) => {
        const b = await res.json().catch(() => ({}));
        if (!live) return;
        if (!res.ok) setError(b?.error?.message ?? `HTTP ${res.status}`);
        else setEnabled(b.enabled === true);
      })
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [tenantId]);

  const flip = async () => {
    if (enabled === null) return;
    const next = !enabled;
    setBusy(true);
    setError(null);
    try {
      const res = await adminApiFetch(`/api/admin/settings`, {
        method: "PUT",
        body: JSON.stringify({ key: "cgo_autopilot_enabled", scope: "tenant", tenant_id: tenantId, value: next }),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(b?.error?.message ?? `HTTP ${res.status}`);
      setEnabled(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">Autopilot cgo</h3>
          <p className="mt-0.5 text-xs text-slate-500">
            Off: weekly advice email, changes nothing. On: cgo changes goals (undoable), pauses channels it picked, and
            reviews early on alarms. The founder can also flip this on their Growth page.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled === true}
          disabled={busy || enabled === null}
          onClick={() => void flip()}
          className={`shrink-0 rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${
            enabled ? "bg-emerald-600 text-white hover:bg-emerald-700" : "bg-slate-100 text-slate-700 hover:bg-slate-200"
          }`}
        >
          {enabled === null ? "…" : enabled ? "On" : "Off"}
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </div>
  );
}
