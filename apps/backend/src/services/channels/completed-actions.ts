
import { parseMoveTest, readoutDay, VERDICTS } from "@/services/growth/cgo-tests";

export const COMPLETED_SHOW_DAYS = 7;
export const COMPLETED_LOOKBACK_DAYS = 60;
export const COMPLETED_MAX = 10;
export const COMPLETED_READ_CAP = 2000;
export const ROW_PAGE = 1000;
export const IN_CHUNK = 100;

const DAY = 86_400_000;

export type Verdict = (typeof VERDICTS)[number];

export type CardOutcome = {
  readout_on: string | null;
  success_if: string;
  verdict?: Verdict;
  result?: string;
  spend_line?: string;
};

export type OutcomeSource = {
  id: string;
  decision_class: string;
  emitted_at: string;
  body: Record<string, unknown> | null;
};

const VERDICT_SET: ReadonlySet<string> = new Set(VERDICTS);

export function outcomeOf(
  move: OutcomeSource | null | undefined,
  cgoClass: string,
  launchedAt: string | null,
): (CardOutcome & { read_at?: string }) | null {
  if (!move || move.decision_class !== cgoClass) return null;
  const b = move.body ?? {};
  if (b.dispatched_by !== "cgo") return null;
  const test = parseMoveTest(b.test);
  if (!test) return null;
  const out: CardOutcome & { read_at?: string } = launchedAt
    ? { readout_on: readoutDay(move.emitted_at, test, launchedAt), success_if: test.success_if }
    : { readout_on: null, success_if: test.success_if };
  const r = b.test_readout as { verdict?: unknown; result?: unknown; read_at?: unknown } | null | undefined;
  if (r && typeof r.verdict === "string" && VERDICT_SET.has(r.verdict)) {
    out.verdict = r.verdict as Verdict;
    if (typeof r.result === "string" && r.result.trim()) out.result = r.result.trim().slice(0, 200);
    if (typeof r.read_at === "string") out.read_at = r.read_at;
  }
  return out;
}

export function shownUntil(executedAt: string, outcome: (CardOutcome & { read_at?: string }) | null): number | null {
  const ran = Date.parse(executedAt);
  if (!outcome) return ran + COMPLETED_SHOW_DAYS * DAY;
  if (!outcome.verdict) return null;
  const read = outcome.read_at ? Date.parse(outcome.read_at) : NaN;
  return Math.max(ran, Number.isFinite(read) ? read : ran) + COMPLETED_SHOW_DAYS * DAY;
}

export function pickCompleted<T extends { id: string; executed_at: string | null; refused_at?: string | null }>(
  rows: readonly T[],
  outcomes: ReadonlyMap<string, (CardOutcome & { read_at?: string }) | null>,
  nowMs: number,
): Array<T & { outcome: CardOutcome | null }> {
  const kept: Array<{ row: T; doneAt: string; outcome: (CardOutcome & { read_at?: string }) | null; waiting: boolean }> = [];
  for (const row of rows) {
    const doneAt = row.executed_at ?? row.refused_at ?? null;
    if (!doneAt || !Number.isFinite(Date.parse(doneAt))) continue;
    const outcome = row.executed_at ? outcomes.get(row.id) ?? null : null;
    const until = shownUntil(doneAt, outcome);
    if (until !== null && until <= nowMs) continue;
    kept.push({ row, doneAt, outcome, waiting: until === null });
  }
  kept.sort((a, b) => Date.parse(b.doneAt) - Date.parse(a.doneAt));
  const waiting = kept.filter((k) => k.waiting);
  const rest = kept.filter((k) => !k.waiting);
  const chosen = new Set([...waiting, ...rest].slice(0, COMPLETED_MAX));
  return kept
    .filter((k) => chosen.has(k))
    .map(({ row, outcome }) => {
      if (!outcome) return { ...row, outcome: null };
      const { read_at: _r, ...wire } = outcome;
      void _r;
      return { ...row, outcome: wire };
    });
}
