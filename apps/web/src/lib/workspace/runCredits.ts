import { apiFetch } from "@/lib/api";

export type RunCreditStatus = "settled" | "pending" | "refunded" | "covered" | "none";
export type RunCreditsEntry = { credits: number; usd: number; status: RunCreditStatus; covered?: number; daily?: number };

export async function fetchRunCreditsByRun(
  runIds: ReadonlyArray<string>,
): Promise<Record<string, RunCreditsEntry>> {
  const ids = Array.from(new Set(runIds.filter((id) => id.length > 0)));
  if (ids.length === 0) return {};

  const res = await apiFetch(`/api/billing/run-credits?ids=${encodeURIComponent(ids.join(","))}`);
  if (!res.ok) throw new Error(`run-credits ${res.status}`);
  const body = (await res.json()) as { runs?: Record<string, RunCreditsEntry> };
  const byRun: Record<string, RunCreditsEntry> = {};
  for (const id of ids) {
    const entry = body.runs?.[id] ?? body.runs?.[id.toLowerCase()];
    if (entry !== undefined) byRun[id] = entry;
  }
  return byRun;
}

export function summarizeRunCredits(entries: ReadonlyArray<RunCreditsEntry>): RunCreditsEntry {
  const credits = entries.reduce((total, entry) => total + Math.max(0, entry.credits), 0);
  const usd = entries.reduce((total, entry) => total + Math.max(0, entry.usd), 0);
  const covered = entries.reduce((total, entry) => total + Math.max(0, entry.covered ?? 0), 0);
  const daily = entries.reduce((total, entry) => total + Math.max(0, entry.daily ?? 0), 0);
  const status: RunCreditStatus = entries.some((entry) => entry.status === "pending")
    ? "pending"
    : credits > 0
      ? "settled"
      : covered > 0 || entries.some((entry) => entry.status === "settled")
        ? "covered"
        : entries.some((entry) => entry.status === "refunded")
          ? "refunded"
          : "none";
  const summary: RunCreditsEntry = { credits, usd: Number(usd.toFixed(4)), status };
  if (covered > 0) summary.covered = covered;
  if (daily > 0) summary.daily = daily;
  return summary;
}

export async function fetchRunCredits(runIds: ReadonlyArray<string>): Promise<RunCreditsEntry> {
  const ids = Array.from(new Set(runIds.filter((id) => id.length > 0)));
  if (ids.length === 0) return { credits: 0, usd: 0, status: "none" };
  return summarizeRunCredits(Object.values(await fetchRunCreditsByRun(ids)));
}
