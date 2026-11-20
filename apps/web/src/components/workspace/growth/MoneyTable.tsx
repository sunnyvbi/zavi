"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { AD_BUDGET_CHANGED_EVENT } from "./adBudgetEvents";

export type MoneyTableRow = {
  platform: string;
  name: string;
  spent_usd: number;
  share: number | null;
  last7_usd: number;
  prev7_usd: number;
  change: number | null;
  results: {
    count: number;
    label: string;
    cost_each_usd: number | null;
    source: string;
    from: string;
    to: string;
    settling: boolean;
  } | null;
  results_status: "platform" | "not_synced" | "unavailable" | "read_failed";
  spend_read_failed: boolean;
};

export type MoneyTableData = {
  month_start: string;
  today: string;
  spend_through: string | null;
  rows: MoneyTableRow[];
  total: { spent_usd: number; last7_usd: number; prev7_usd: number; change: number | null };
  budget: { status: "active" | "stopped"; month_cap_usd: number; monthly_usd: number; spent_usd: number } | null;
  results_read_at: string | null;
};

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function usd(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function countLabel(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export function shortDay(ymd: string): string {
  const [, m, d] = ymd.split("-").map(Number);
  return `${MONTHS[(m || 1) - 1].slice(0, 3)} ${d}`;
}

export function changeLabel(change: number | null, last7: number): string {
  if (change === null) return last7 > 0 ? "new" : "—";
  const pct = Math.round(change * 100);
  return `${pct > 0 ? "+" : ""}${pct}%`;
}

function pctLabel(share: number | null): string {
  if (share === null) return "—";
  const p = share * 100;
  return p > 0 && p < 1 ? "<1%" : `${Math.round(p)}%`;
}

const RESULT_GAP: Record<Exclude<MoneyTableRow["results_status"], "platform">, string> = {
  not_synced: "not synced yet",
  unavailable: "not read yet",
  read_failed: "couldn't read",
};

function rangeOf(r: MoneyTableRow): string {
  return `${r.name.replace(/ Ads$/, "")} ${shortDay(r.results!.from)} to ${shortDay(r.results!.to)}`;
}

export function resultsDays(rows: MoneyTableRow[]): string | null {
  const withResults = rows.filter((r) => r.results !== null);
  if (withResults.length === 0) return null;
  const first = withResults[0].results!;
  const same = withResults.every((r) => r.results!.from === first.from && r.results!.to === first.to);
  return same ? `${shortDay(first.from)} to ${shortDay(first.to)}` : withResults.map(rangeOf).join(", ");
}

function ResultsCell({ row }: { row: MoneyTableRow }) {
  if (row.results) {
    return (
      <span>
        {countLabel(row.results.count)} {row.results.label}
        <span className="block text-[11px] text-inkMuted">{row.results.source}</span>
      </span>
    );
  }
  return (
    <span className="text-inkMuted">
      <span aria-hidden="true">— </span>
      {RESULT_GAP[row.results_status as keyof typeof RESULT_GAP] ?? "not read yet"}
    </span>
  );
}

export function MoneyTableView({ data, className = "mt-5" }: { data: MoneyTableData; className?: string }) {
  const month = MONTHS[Number(data.month_start.slice(5, 7)) - 1] ?? "This month";
  const t = data.total;
  const budget = data.budget;
  const days = resultsDays(data.rows);
  const anyNotSynced = data.rows.some((r) => r.results_status === "not_synced");
  const anyReadFailed = data.rows.some((r) => r.results_status === "read_failed");
  const anySettling = data.rows.some((r) => r.results?.settling === true);
  const anySpendUnread = data.rows.some((r) => r.spend_read_failed);
  const budgetLine = budget
    ? `budget: ${usd(budget.spent_usd)} of ${usd(budget.month_cap_usd)} used${budget.status === "stopped" ? " (stopped)" : ""}`
    : "no monthly ad budget set";

  return (
    <section aria-label="Where your ad money goes" data-testid="money-table" className={`${className} rounded-2xl border border-rule bg-cream`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-4 pt-3.5">
        <h2 className="text-[15px] font-semibold leading-6 text-ink">Where your ad money goes</h2>
        <span className="text-[12px] text-inkMuted">{month} so far</span>
      </div>
      <p className="px-4 pt-1 text-[13px] text-inkMuted" data-testid="money-table-summary">
        <b className="font-semibold text-ink tabular-nums">{usd(t.spent_usd)}</b>
        {` spent · ${budgetLine}`}
        {` · last 7 days ${usd(t.last7_usd)}`}
        {t.change !== null && `, ${changeLabel(t.change, t.last7_usd)} on the week before`}
      </p>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[520px] text-[13px] compact:min-w-0">
          <thead>
            <tr className="text-left text-[11px] text-inkMuted">
              <th scope="col" className="py-1.5 pl-4 font-medium">Channel</th>
              <th scope="col" className="py-1.5 pl-3 text-right font-medium">Spent</th>
              <th scope="col" className="py-1.5 pl-3 text-right font-medium compact:hidden">Share</th>
              <th scope="col" className="py-1.5 pl-3 text-right font-medium">7 days</th>
              <th scope="col" className="py-1.5 pl-4 font-medium compact:hidden">Results, last 30 days</th>
              <th scope="col" className="py-1.5 pl-3 pr-4 text-right font-medium compact:hidden">Cost each</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.platform} className="border-t border-rule align-top" data-testid={`money-row-${r.platform}`}>
                <th scope="row" className="py-2 pl-4 text-left font-semibold text-ink">
                  {r.name}
                  {}
                  <span className="hidden text-[11px] font-normal text-inkMuted compact:block">
                    {r.results
                      ? `${countLabel(r.results.count)} ${r.results.label}${r.results.cost_each_usd != null ? `, ${usd(r.results.cost_each_usd)} each` : ""}`
                      : `Results ${RESULT_GAP[r.results_status as keyof typeof RESULT_GAP] ?? "not read yet"}`}
                  </span>
                </th>
                <td className="py-2 pl-3 text-right font-semibold tabular-nums text-ink">{usd(r.spent_usd)}</td>
                <td className="py-2 pl-3 text-right tabular-nums text-inkMuted compact:hidden">{pctLabel(r.share)}</td>
                <td className="py-2 pl-3 text-right tabular-nums text-ink" title={`Last 7 days ${usd(r.last7_usd)}, the 7 before ${usd(r.prev7_usd)}`}>
                  {r.spend_read_failed ? <span className="text-inkMuted">couldn&apos;t read</span> : changeLabel(r.change, r.last7_usd)}
                </td>
                <td className="py-2 pl-4 text-ink compact:hidden">
                  <ResultsCell row={r} />
                </td>
                <td className="py-2 pl-3 pr-4 text-right tabular-nums text-ink compact:hidden">
                  {r.results?.cost_each_usd != null ? usd(r.results.cost_each_usd) : <span className="text-inkMuted">—</span>}
                </td>
              </tr>
            ))}
            <tr className="border-t border-rule align-top font-semibold" data-testid="money-row-total">
              <th scope="row" className="py-2 pl-4 text-left text-ink">Total</th>
              <td className="py-2 pl-3 text-right tabular-nums text-ink">
                {usd(t.spent_usd)}
                <span className="block text-[11px] font-normal text-inkMuted" data-testid="money-budget-line">
                  {budget ? `budget ${usd(budget.spent_usd)} of ${usd(budget.month_cap_usd)}` : "no budget set"}
                </span>
              </td>
              <td className="py-2 pl-3 text-right tabular-nums text-inkMuted compact:hidden">{t.spent_usd > 0 ? "100%" : "—"}</td>
              <td className="py-2 pl-3 text-right tabular-nums text-ink">{anySpendUnread ? <span className="font-normal text-inkMuted">—</span> : changeLabel(t.change, t.last7_usd)}</td>
              <td className="py-2 pl-4 compact:hidden" />
              <td className="py-2 pl-3 pr-4 compact:hidden" />
            </tr>
          </tbody>
        </table>
      </div>
      <p className="border-t border-rule px-4 py-2 text-[11px] text-inkMuted">
        {data.spend_through ? `Spend from your ad accounts, through ${shortDay(data.spend_through)}; today's spend is still adding up. ` : null}
        7 days compares the last 7 full days with the 7 before.
        {days ? ` Results are each platform's own count, not your bookings, for ${days}.` : null}
        {anySettling ? " The newest days are still settling, so those counts may rise." : null}
        {anySpendUnread ? " Some spend could not be read on the last check, so its 7-day change is left out." : null}
        {anyReadFailed ? " Meta or Google results could not be read just now." : null}
        {anyNotSynced ? " Zavi does not sync results for the other channels yet." : null}
        {budget ? " The budget counts spend from the day it started and keeps the highest figure it has read, so it can differ from the rows." : null}
      </p>
    </section>
  );
}

export function MoneyTable({ className = "mt-5", alwaysShow = false }: { className?: string; alwaysShow?: boolean } = {}) {
  const [data, setData] = useState<MoneyTableData | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch("/api/workspace/ad-budget/channels");
      if (!res.ok) throw new Error("read");
      const body = (await res.json()) as Partial<MoneyTableData> | null;
      if (!body || !Array.isArray(body.rows) || !body.total || typeof body.month_start !== "string") throw new Error("shape");
      setData(body as MoneyTableData);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
    const reread = () => void load();
    window.addEventListener(AD_BUDGET_CHANGED_EVENT, reread);
    return () => window.removeEventListener(AD_BUDGET_CHANGED_EVENT, reread);
  }, [load]);

  const retry = (line: string) => (
    <p role="alert" className="mt-2 flex flex-wrap items-center gap-2 text-[13px] text-warn dark:text-marigold">
      {line}
      <button type="button" onClick={() => void load()} className="font-semibold text-ink underline decoration-rule underline-offset-2">
        Try again
      </button>
    </p>
  );
  if (failed && !data) return <div className={className}>{retry("Couldn't load where your ad money goes.")}</div>;
  if (!data) return null;
  if (data.rows.length === 0) {
    if (!data.budget && !alwaysShow) return failed ? <div className={className}>{retry("Couldn't refresh where your ad money goes.")}</div> : null;
    if (!data.budget) {
      return (
        <section aria-label="Where your ad money goes" data-testid="money-table-none" className={`${className} rounded-2xl border border-rule bg-cream px-4 py-3.5`}>
          <h2 className="text-[15px] font-semibold leading-6 text-ink">Where your ad money goes</h2>
          <p className="text-[15px] leading-6 text-inkMuted">No ad spend this month. Each ad channel&apos;s spend and results show here once ads run.</p>
          {failed && retry("Couldn't refresh. This may be out of date.")}
        </section>
      );
    }
    return (
      <section aria-label="Where your ad money goes" data-testid="money-table-empty" className={`${className} rounded-2xl border border-rule bg-cream px-4 py-3`}>
        <h2 className="text-[15px] font-semibold leading-6 text-ink">Where your ad money goes</h2>
        <p className="mt-1 text-[13px] text-inkMuted">
          No ad spend read yet this month, against a {usd(data.budget.month_cap_usd)} budget. Spend shows here once Zavi reads it from your ad accounts; it checks every hour.
        </p>
        {failed && retry("Couldn't refresh. This may be out of date.")}
      </section>
    );
  }
  return (
    <>
      <MoneyTableView data={data} className={className} />
      {}
      {failed && retry("Couldn't refresh. These numbers may be out of date.")}
    </>
  );
}
