"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { adminApiFetch } from "@/lib/api-admin";

type Status = {
  status: "limited" | "ok" | "unknown";
  limited: boolean;
  resets_at: string | null;
  auth_mode: "api_key" | "subscription_oauth";
  advice: string;
  window_minutes: number;
  limit_error_count: number;
  runs_scanned: number;
  last_limit_at: string | null;
  last_limit_run: { id: string; agent_slug: string | null; tenant_id: string | null } | null;
  last_success_at: string | null;
};

export default function UsageLimitPage() {
  return <Body />;
}

function Body() {
  const [data, setData] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [minutes, setMinutes] = useState(30);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await adminApiFetch(`/api/admin/usage-limit-status?minutes=${minutes}`);
      const r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
      setData(r as Status);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [minutes]);

  useEffect(() => {
    void load();
  }, [load]);

  const verdict = data?.status;
  const tone =
    verdict === "limited"
      ? { box: "border-rose-200 bg-rose-50 text-rose-800", dot: "bg-rose-500", label: "LIMITED" }
      : verdict === "ok"
        ? { box: "border-emerald-200 bg-emerald-50 text-emerald-800", dot: "bg-emerald-500", label: "OK" }
        : { box: "border-slate-200 bg-slate-50 text-slate-700", dot: "bg-slate-400", label: "UNKNOWN" };

  return (
    <div className="max-w-3xl mx-auto p-6">
      <div className="flex items-center justify-between mb-5">
        <div>
          <div className="text-xs uppercase tracking-[0.2em] text-sky-700">
            Zavi · admin
          </div>
          <h1 className="font-display font-semibold text-2xl text-slate-900 mt-1">
            Usage limit
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Is the agent fleet wedged on a Claude usage cap right now? Read-only — no quota spent.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={minutes}
            onChange={(e) => setMinutes(Number(e.target.value))}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm"
          >
            <option value={15}>15m</option>
            <option value={30}>30m</option>
            <option value={60}>1h</option>
            <option value={180}>3h</option>
            <option value={720}>12h</option>
          </select>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="rounded-md bg-slate-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {loading ? "Checking…" : "Re-check"}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 mb-4">
          {error}
        </div>
      )}

      {data === null ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : (
        <div className={"rounded-xl border p-5 " + tone.box}>
          <div className="flex items-center gap-2.5 mb-3">
            <span className={"inline-block h-2.5 w-2.5 rounded-full " + tone.dot} />
            <span className="text-base font-semibold tracking-wide">{tone.label}</span>
            {data.resets_at && data.limited && (
              <span className="text-sm opacity-80">· resets {data.resets_at}</span>
            )}
          </div>

          <p className="text-sm leading-relaxed mb-4">{data.advice}</p>

          <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
            <Row k="Auth mode" v={data.auth_mode === "api_key" ? "API key" : "Subscription (OAuth)"} />
            <Row k="Window" v={`${data.window_minutes}m`} />
            <Row k="Limit errors" v={String(data.limit_error_count)} />
            <Row k="Runs scanned" v={String(data.runs_scanned)} />
            <Row k="Last limit" v={fmt(data.last_limit_at)} />
            <Row k="Last success" v={fmt(data.last_success_at)} />
          </dl>

          {data.last_limit_run && (
            <div className="mt-4 pt-3 border-t border-current/10 text-sm">
              Tripped by{" "}
              <code className="font-mono">{data.last_limit_run.agent_slug ?? "?"}</code> ·{" "}
              <Link
                href={`/runs/${data.last_limit_run.id}`}
                className="underline underline-offset-2 font-mono"
              >
                {data.last_limit_run.id.slice(0, 8)}
              </Link>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="opacity-70">{k}</dt>
      <dd className="font-medium text-right">{v}</dd>
    </>
  );
}

function fmt(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}
