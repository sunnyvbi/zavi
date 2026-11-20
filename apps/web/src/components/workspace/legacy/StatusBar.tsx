"use client";

import { num } from "../counters";
import { creditCellClass } from "@/lib/workspace/runEstimate";

type Counters = {
  drift_pct: number;
  cost_today_usd: number;
  active_runs: number;
  approvals_pending: number;
  credits_remaining?: number | null;
  credits_enforced?: boolean;
  credits_unlimited?: boolean;
  included_allowance?: number | null;
};

function fmtCredits(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}k`;
  return `${n}`;
}

export function StatusBar({
  counters,
  loaded = true,
}: {
  counters: Counters;
  loaded?: boolean;
}) {
  return (
    <footer
      role="status"
      aria-live="polite"
      className="shrink-0 px-4 py-2.5 text-[12px] text-inkMuted"
      style={{ borderTop: "1px solid rgba(10,31,58,0.06)" }}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {}
        <Cell
          label="Drift"
          value={loaded ? `${num(counters.drift_pct)}%` : "-"}
          tip="Share of agent runs in the last 24h that drifted from policy. 0% is healthy."
        />
        {}
        {!counters.credits_enforced && (
          <Cell
            label="Today"
            value={loaded ? `$${num(counters.cost_today_usd).toFixed(2)}` : "-"}
            valueClass={loaded && num(counters.cost_today_usd) > 0 ? "text-ink" : ""}
            tip="Total Anthropic + tool spend by your agents since 00:00 UTC."
          />
        )}
        <Cell
          label="Active"
          value={loaded ? `${num(counters.active_runs)}` : "-"}
          valueClass={loaded && num(counters.active_runs) > 0 ? "text-mintDeep" : ""}
          tip="Agent runs currently executing (queued or running)."
        />
        <Cell
          label="Pending"
          value={loaded ? `${num(counters.approvals_pending)}` : "-"}
          valueClass={loaded && num(counters.approvals_pending) > 0 ? "text-marigoldDeep" : ""}
          tip="Decisions across ALL agents waiting for you to approve or reject: the canonical to-do count. Open Needs you to act."
        />
        {}
        {counters.credits_enforced && (
          <Cell
            label="Credits"
            value={
              counters.credits_unlimited
                ? "Unlimited"
                : loaded && typeof counters.credits_remaining === "number"
                  ? fmtCredits(counters.credits_remaining)
                  : "-"
            }
            valueClass={
              counters.credits_unlimited
                ? ""
                : loaded && typeof counters.credits_remaining === "number"
                  ? creditCellClass(counters.credits_remaining, counters.included_allowance)
                  : ""
            }
            tip={
              counters.credits_unlimited
                ? "This workspace has unlimited credits, so runs are never blocked for balance."
                : "Credits remaining this period (included allowance + top-ups − in-flight holds). Each agent run debits credits at $0.0025 each. Buy more in Billing."
            }
          />
        )}
      </div>
    </footer>
  );
}

function Cell({
  label,
  value,
  valueClass = "",
  tip,
}: {
  label: string;
  value: string;
  valueClass?: string;
  tip?: string;
}) {
  return (
    <span className="flex items-baseline gap-1" title={tip}>
      <span className="text-inkMuted/80">{label}</span>
      <span className={`font-mono tabular-nums text-inkSoft ${valueClass}`}>{value}</span>
    </span>
  );
}
