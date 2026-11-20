"use client";

import { useCallback, useEffect, useState } from "react";
import { Activity, Loader2, RotateCcw } from "lucide-react";
import {
  fetchRunCreditsByRun,
  summarizeRunCredits,
  type RunCreditsEntry,
} from "@/lib/workspace/runCredits";

const IDS_PER_REQUEST = 40;

export type AppUsage = {
  total: RunCreditsEntry;
  runs: Array<{ id: string; label: string; usage: RunCreditsEntry }>;
};

const NO_CREDITS: RunCreditsEntry = { credits: 0, usd: 0, status: "none" };

export function usedCredits(entry: RunCreditsEntry): number {
  return Math.max(0, entry.credits) + Math.max(0, entry.covered ?? 0);
}

export async function fetchAppUsage(runIds: ReadonlyArray<string>): Promise<AppUsage> {
  const ids = Array.from(new Set(runIds.filter((id) => id.length > 0)));
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += IDS_PER_REQUEST) chunks.push(ids.slice(i, i + IDS_PER_REQUEST));
  const parts = await Promise.all(chunks.map((chunk) => fetchRunCreditsByRun(chunk)));
  const byRun: Record<string, RunCreditsEntry> = Object.assign({}, ...parts);
  const runs = ids.map((id, i) => ({
    id,
    label: i === 0 ? "First build" : `Change ${i}`,
    usage: byRun[id] ?? NO_CREDITS,
  }));
  return { total: summarizeRunCredits(Object.values(byRun)), runs };
}

type Load = { state: "loading" } | { state: "ready"; usage: AppUsage } | { state: "error" };

const plural = (n: number) => (n === 1 ? "credit" : "credits");

export function AppUsageCard({
  runIds,
  onOpenBilling,
}: {
  runIds: ReadonlyArray<string>;
  onOpenBilling: () => void;
}) {
  const key = runIds.join(",");
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoad({ state: "loading" });
    fetchAppUsage(key ? key.split(",") : [])
      .then((usage) => {
        if (!cancelled) setLoad({ state: "ready", usage });
      })
      .catch(() => {
        if (!cancelled) setLoad({ state: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [key, attempt]);

  return (
    <div className="rounded-2xl border border-[#f0f0f0] p-4" data-testid="app-usage-card">
      <h3 className="text-[16px] font-semibold text-[#0e0f11]">App usage</h3>
      <p className="mt-0.5 text-[12px] leading-5 text-[#8c8c8c]">
        Credits spent building and changing this app.
      </p>
      <div className="mt-3 min-h-[44px]" aria-live="polite">
        {load.state === "loading" ? (
          <span className="inline-flex items-center gap-2 text-[13px] text-[#8c8c8c]">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading usage…
          </span>
        ) : load.state === "error" ? (
          <div className="flex flex-wrap items-center gap-2 text-[13px] text-[#595959]">
            We couldn&rsquo;t load usage.
            <button
              type="button"
              onClick={retry}
              className="inline-flex h-8 items-center gap-1 rounded-cta px-2 text-[13px] font-medium text-[#0e0f11] transition-colors hover:bg-[#f4f4f4]"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Retry
            </button>
          </div>
        ) : (
          <UsageBody usage={load.usage} />
        )}
      </div>
      <button
        type="button"
        onClick={onOpenBilling}
        className="mt-3 inline-flex h-10 w-full items-center justify-center gap-2 rounded-cta border border-[#f0f0f0] bg-white px-3 text-[13px] font-medium text-[#0e0f11] transition-colors hover:bg-[#f9f9f9]"
      >
        <Activity className="h-4 w-4 text-[#595959]" aria-hidden /> Billing &amp; credits
      </button>
    </div>
  );
}

function UsageBody({ usage }: { usage: AppUsage }) {
  const used = usedCredits(usage.total);
  const daily = Math.max(0, usage.total.daily ?? 0);
  if (usage.runs.length === 0) {
    return <p className="text-[13px] text-[#8c8c8c]">No builds yet</p>;
  }
  return (
    <>
      <p className="text-[20px] font-semibold tabular-nums leading-7 text-[#0e0f11]">
        {used.toLocaleString("en-US")}{" "}
        <span className="text-[13px] font-medium text-[#595959]">{plural(used)} used</span>
        {usage.total.status === "pending" && (
          <span className="ml-2 text-[12px] font-medium text-[#8c8c8c]">settling…</span>
        )}
      </p>
      {daily > 0 && (
        <p className="text-[12px] leading-5 text-[#8c8c8c]" data-testid="app-usage-covered">
          {daily.toLocaleString("en-US")} covered by daily credits
        </p>
      )}
      <ul className="mt-3 max-h-48 divide-y divide-[#f0f0f0] overflow-y-auto border-t border-[#f0f0f0]" aria-label="Credits per build">
        {usage.runs.map((run) => {
          const n = usedCredits(run.usage);
          return (
            <li key={run.id} className="flex items-center justify-between gap-3 py-1.5 text-[13px]">
              <span className="min-w-0 truncate text-[#595959]">{run.label}</span>
              <span className="shrink-0 tabular-nums text-[#0e0f11]">
                {run.usage.status === "pending" ? (
                  <span className="text-[#8c8c8c]">settling…</span>
                ) : (
                  `${n.toLocaleString("en-US")} ${plural(n)}`
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </>
  );
}
