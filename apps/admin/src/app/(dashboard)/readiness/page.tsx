"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { adminApiFetch } from "@/lib/api-admin";
import { PageHeader } from "@/components/admin/PageHeader";

type Lane = "act" | "nurture" | "operable" | "unscored";

interface Traction {
  status: "measured" | "absent";
  metric_key?: string;
  value?: number;
  window_end?: string;
}

interface BoardRow {
  tenant_id: string;
  slug: string;
  display_name: string | null;
  company_shape: string | null;
  score: number | null;
  dimensions: Record<string, number> | null;
  computed_at: string | null;
  lane: Lane;
  top_gap: string | null;
  connector_gap: boolean;
  agent_addressable: boolean;
  park_reason: string;
  plan: string | null;
  sub_status: string | null;
  paying: boolean;
  grandfathered: boolean;
  churn_signal: string | null;
  traction: Traction;
  fde_touches: number;
  last_fde_touch_at: string | null;
}

interface DecisiveAction {
  tenant_id: string;
  slug: string;
  display_name: string | null;
  gap_dimension: string | null;
  action: string;
  why: string;
}

interface Board {
  rows: BoardRow[];
  decisive: DecisiveAction | null;
  delegate: DecisiveAction | null;
  watch: DecisiveAction | null;
  evidence_rate: { status: string; why: string };
  counts: { act: number; nurture: number; operable: number; unscored: number; total: number };
}

const LANE_STYLE: Record<Lane, { label: string; cls: string }> = {
  act: { label: "Needs a human", cls: "bg-amber-100 text-amber-800" },
  nurture: { label: "Agent can still move it", cls: "bg-sky-100 text-sky-800" },
  operable: { label: "Operable", cls: "bg-emerald-100 text-emerald-800" },
  unscored: { label: "Not yet scored", cls: "bg-slate-100 text-slate-600" },
};

export default function ReadinessPage() {
  const [board, setBoard] = useState<Board | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showBoard, setShowBoard] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await adminApiFetch("/api/admin/readiness");
        const r = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
        if (!cancelled) setBoard(r as Board);
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (err) {
    return (
      <div className="max-w-7xl mx-auto p-6">
        <PageHeader title="Readiness" />
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
          Could not load the board: {err}
        </div>
      </div>
    );
  }

  if (!board) {
    return (
      <div className="max-w-7xl mx-auto p-6">
        <PageHeader title="Readiness" />
        <div className="text-sm text-slate-500">Loading…</div>
      </div>
    );
  }

  const { counts } = board;

  return (
    <div className="max-w-7xl mx-auto p-6">
      <PageHeader
        title="Readiness"
        subtitle="Where an hour of human time actually converts. One action, not a backlog."
      />

      {}
      <div className="mb-6 flex flex-wrap gap-2 text-xs">
        <Chip label={`${counts.act} need a human`} cls="bg-amber-100 text-amber-800" />
        <Chip label={`${counts.nurture} an agent can still move`} cls="bg-sky-100 text-sky-800" />
        <Chip label={`${counts.operable} operable`} cls="bg-emerald-100 text-emerald-800" />
        {counts.unscored > 0 && (
          <Chip label={`${counts.unscored} not yet scored`} cls="bg-slate-100 text-slate-600" />
        )}
      </div>

      {}
      <ActionCard
        kind="do"
        title="Do this"
        action={board.decisive}
        empty="Nothing needs a human right now. Every stuck tenant still has work an agent can do."
      />

      <div className="grid gap-4 md:grid-cols-2 mt-4">
        <ActionCard
          kind="delegate"
          title="Delegate this"
          action={board.delegate}
          empty="Nothing to delegate — no tenant has agent-addressable work outstanding."
        />
        <ActionCard
          kind="watch"
          title="Watch this"
          action={board.watch}
          empty="No operable tenant is showing a billing churn signal."
        />
      </div>

      {}
      <div className="mt-6 rounded-lg border border-slate-200 bg-slate-50 p-4">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-slate-900">Weekly evidence rate</span>
          <span className="rounded px-2 py-0.5 text-xs bg-slate-200 text-slate-700">
            not instrumented
          </span>
        </div>
        <p className="mt-1 text-xs text-slate-600">{board.evidence_rate.why}</p>
      </div>

      {}
      <div className="mt-8">
        <button
          onClick={() => setShowBoard((v) => !v)}
          className="text-sm text-sky-700 hover:text-sky-900 font-medium"
        >
          {showBoard ? "Hide" : "Show"} the ranked board ({counts.total} tenants) — the
          derivation behind the card above
        </button>

        {showBoard && (
          <div className="mt-4 overflow-x-auto rounded-lg border border-slate-200">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2">Tenant</th>
                  <th className="px-3 py-2">Lane</th>
                  <th className="px-3 py-2">Score</th>
                  <th className="px-3 py-2">Top gap</th>
                  <th className="px-3 py-2">Billing</th>
                  <th className="px-3 py-2">Traction</th>
                  <th className="px-3 py-2">FDE touches</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {board.rows.map((r) => (
                  <tr key={r.tenant_id} className="hover:bg-slate-50">
                    <td className="px-3 py-2">
                      <Link
                        href={`/tenants/${r.tenant_id}`}
                        className="text-sky-700 hover:underline font-medium"
                      >
                        {r.display_name ?? r.slug}
                      </Link>
                      <div className="text-xs text-slate-400">{r.slug}</div>
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`rounded px-2 py-0.5 text-xs ${LANE_STYLE[r.lane].cls}`}
                        title={r.park_reason}
                      >
                        {LANE_STYLE[r.lane].label}
                      </span>
                    </td>
                    <td className="px-3 py-2 tabular-nums">
                      {}
                      {r.score === null ? (
                        <span className="text-slate-400">not yet computed</span>
                      ) : (
                        <span className={r.score >= 70 ? "text-emerald-700" : "text-slate-900"}>
                          {r.score}
                          <span className="text-slate-400">/100</span>
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {r.top_gap ? (
                        <span className={r.connector_gap ? "font-medium text-amber-800" : ""}>
                          {r.top_gap.replace(/_/g, " ")}
                        </span>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {r.paying ? (
                        <span className="text-emerald-700">paying ({r.plan})</span>
                      ) : r.grandfathered ? (
                        <span className="text-slate-500" title="Never charged — lifetime free Full">
                          grandfathered
                        </span>
                      ) : (
                        <span className="text-slate-400">{r.plan ?? "—"}</span>
                      )}
                      {r.churn_signal && (
                        <div className="text-rose-700">{r.churn_signal.replace(/_/g, " ")}</div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {r.traction.status === "measured" ? (
                        <span title={`window ending ${r.traction.window_end}`}>
                          {r.traction.metric_key?.replace(/_/g, " ")}: {r.traction.value}
                        </span>
                      ) : (
                        <span className="text-slate-400" title="No growth metric measured for this tenant">
                          not measured
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 tabular-nums text-xs">
                      {r.fde_touches === 0 ? (
                        <span className="text-slate-400">never</span>
                      ) : (
                        r.fde_touches
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function Chip({ label, cls }: { label: string; cls: string }) {
  return <span className={`rounded-full px-2.5 py-1 ${cls}`}>{label}</span>;
}

const KIND_STYLE = {
  do: "border-amber-300 bg-amber-50",
  delegate: "border-sky-200 bg-sky-50",
  watch: "border-slate-200 bg-white",
} as const;

function ActionCard({
  kind,
  title,
  action,
  empty,
}: {
  kind: keyof typeof KIND_STYLE;
  title: string;
  action: DecisiveAction | null;
  empty: string;
}) {
  if (!action) {
    return (
      <div className={`rounded-lg border p-4 ${KIND_STYLE[kind]}`}>
        <div className="text-xs uppercase tracking-wide text-slate-500">{title}</div>
        <p className="mt-2 text-sm text-slate-500">{empty}</p>
      </div>
    );
  }

  return (
    <div className={`rounded-lg border p-4 ${KIND_STYLE[kind]}`}>
      <div className="text-xs uppercase tracking-wide text-slate-500">{title}</div>
      <Link
        href={`/tenants/${action.tenant_id}`}
        className="mt-1 block font-display text-lg font-semibold text-slate-900 hover:text-sky-800"
      >
        {action.display_name ?? action.slug}
      </Link>
      <p className="mt-2 text-sm text-slate-800">{action.action}</p>
      <p className="mt-2 text-xs text-slate-500">{action.why}</p>
    </div>
  );
}
