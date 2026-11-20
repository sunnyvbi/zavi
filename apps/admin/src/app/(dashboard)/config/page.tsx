"use client";

import { useEffect, useState } from "react";
import { adminApiFetch } from "@/lib/api-admin";
import { CreditPricingCard } from "@/components/admin/CreditPricingCard";
import { LiveRunsCard } from "@/components/admin/LiveRunsCard";

type Resp = {
  blob: Record<string, unknown>;
  updated_at: string | null;
  updated_by: string | null;
};

export default function AdminConfigPage() {
  return <Body />;
}

function Body() {
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [parseErr, setParseErr] = useState<string | null>(null);

  async function load() {
    try {
      const res = await adminApiFetch("/api/admin/config");
      const r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
      setData(r as Resp);
      setDraft(JSON.stringify(r.blob ?? {}, null, 2));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function patch() {
    setSubmitting(true);
    setError(null);
    setParseErr(null);
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(draft || "{}");
      } catch (e) {
        setParseErr((e as Error).message);
        return;
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        setParseErr("Top-level must be a JSON object.");
        return;
      }
      const beforeKeys = new Set(Object.keys(data?.blob ?? {}));
      const afterKeys = new Set(Object.keys(parsed as Record<string, unknown>));
      const removed: string[] = [];
      for (const k of beforeKeys) if (!afterKeys.has(k)) removed.push(k);
      if (removed.length > 0) {
        const ok = window.confirm(
          `These keys are NOT in your edit but PATCH only merges, so they will REMAIN: ${removed.join(", ")}. Continue?`,
        );
        if (!ok) return;
      }
      const res = await adminApiFetch("/api/admin/config", {
        method: "PATCH",
        body: JSON.stringify({ patch: parsed }),
      });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-4xl mx-auto p-6">
      <div className="mb-5">
        <div className="text-xs uppercase tracking-[0.2em] text-sky-700">
          Zavi · admin
        </div>
        <h1 className="font-display font-semibold text-2xl text-slate-900 mt-1">Config</h1>
        <p className="text-sm text-slate-500 mt-1">
          Single-row JSONB blob. Every PATCH writes a {`{before, after}`} diff into the staff
          audit log.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 mb-4">
          {error}
        </div>
      )}
      {parseErr && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 mb-4">
          JSON parse error: {parseErr}
        </div>
      )}

      {!data ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : (
        <>
          <CreditPricingCard blob={data.blob} onSaved={load} />
          <LiveRunsCard blob={data.blob} onSaved={load} />

          <div className="text-sm font-mono text-slate-500 mb-2">
            updated_at:{" "}
            {data.updated_at ? new Date(data.updated_at).toLocaleString() : "never"}
            {data.updated_by && (
              <>
                {" · "}updated_by: <span className="text-slate-700">{data.updated_by.slice(0, 8)}</span>
              </>
            )}
          </div>

          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            rows={20}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm focus:outline-none focus:border-skyMuted focus:ring-1 focus:ring-skyMuted"
          />

          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              onClick={patch}
              disabled={submitting}
              className="rounded-md bg-slate-900 text-white px-3 py-1.5 text-sm font-medium hover:bg-slate-800 disabled:opacity-50"
            >
              {submitting ? "Saving…" : "Save (PATCH merge)"}
            </button>
            <button
              type="button"
              onClick={() => setDraft(JSON.stringify(data.blob, null, 2))}
              className="text-sm font-medium text-slate-600 hover:text-slate-900"
            >
              Reset
            </button>
          </div>
        </>
      )}
    </div>
  );
}
