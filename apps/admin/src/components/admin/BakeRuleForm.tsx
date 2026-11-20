"use client";

import { useState } from "react";
import { adminApiFetch } from "@/lib/api-admin";

type Props = { tenantId: string; slug: string };

export function BakeRuleForm({ tenantId, slug }: Props) {
  const [body, setBody] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function bake() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await adminApiFetch(`/api/admin/tenants/${tenantId}/agents/${slug}/bake`, {
        method: "POST",
        body: JSON.stringify({ rule_body_markdown: body.trim() }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error?.message ?? `HTTP ${res.status}`);
      setDone(true);
      setConfirming(false);
      setBody("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
        ✓ Baked — this rule is now a permanent part of <span>{slug}</span>&apos;s
        body for this tenant (no 14-day decay). It applies on the next run.
      </div>
    );
  }

  return (
    <>
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm space-y-2">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="e.g. Never promise a delivery date without checking the calendar connector first."
          rows={3}
          maxLength={1500}
          disabled={busy}
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-700 focus:outline-none focus:border-slate-500 focus:ring-1 focus:ring-slate-500 disabled:opacity-50"
        />
        <div className="flex items-center justify-between">
          <div className="text-sm font-mono text-slate-500">{body.length}/1500</div>
          <button
            type="button"
            disabled={busy || body.trim().length < 5}
            onClick={() => {
              setError(null);
              setConfirming(true);
            }}
            className="inline-flex items-center rounded-md bg-slate-900 text-white px-3 py-1.5 text-sm font-medium hover:bg-slate-700 disabled:opacity-50"
          >
            Bake permanent…
          </button>
        </div>
        {error && !confirming && <div className="text-sm text-rose-700">{error}</div>}
      </div>

      {confirming && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-5 shadow-xl">
            <h3 className="font-display font-semibold text-base text-slate-900">
              Bake permanent rule into <span>{slug}</span>?
            </h3>
            <p className="mt-1 text-sm text-slate-600">
              This appends the exact text below to this agent&apos;s permanent body for THIS tenant.
              Unlike a steering note it does NOT decay after 14 days. It applies on the next run.
            </p>
            <pre className="mt-3 whitespace-pre-wrap break-words rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-800">
              {body.trim()}
            </pre>
            {error && <div className="mt-2 text-sm text-rose-700">{error}</div>}
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirming(false)}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={bake}
                className="rounded-md bg-slate-900 text-white px-3 py-1.5 text-sm font-medium hover:bg-slate-700 disabled:opacity-50"
              >
                {busy ? "Baking…" : "Bake it"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
