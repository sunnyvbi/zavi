
export type BudgetTestFact = {
  running: { decision_id: string; ends_on: string } | null;
  baselineMissing: boolean;
  testUnreadable?: boolean;
};

export const BUDGET_TEST_RUNNING = "budget_test_running";
export const TEST_BASELINE_MISSING = "test_baseline_missing";
export const BUDGET_TEST_UNKNOWN = "budget_test_unknown";
export const BUDGET_TEST_REVERT = "budget_test_revert";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function dayWords(d: string | undefined): string | null {
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  return `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;
}
const usd = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;

export function budgetTestReasons(f: BudgetTestFact | null | undefined): string[] {
  if (f === undefined) return [];
  if (f === null) return [BUDGET_TEST_UNKNOWN];
  const out: string[] = [];
  if (f.running) out.push(`${BUDGET_TEST_RUNNING}|${f.running.ends_on}`);
  if (f.baselineMissing) out.push(TEST_BASELINE_MISSING);
  if (f.testUnreadable) out.push(BUDGET_TEST_UNKNOWN);
  return out;
}

export function budgetTestRevertReason(endedOn: string, baselineUsd: number): string {
  return `${BUDGET_TEST_REVERT}|${endedOn}|${Math.round(baselineUsd * 100) / 100}`;
}

export function budgetTestWords(reason: string): string | null {
  const [code, a, b] = reason.split("|");
  switch (code) {
    case BUDGET_TEST_RUNNING: {
      const until = dayWords(a);
      return until ? `a budget test is running on it until ${until}, so I don't change it mid-test` : "a budget test is running on it, so I don't change it mid-test";
    }
    case TEST_BASELINE_MISSING:
      return "it is part of a budget test with no baseline budget to go back to when the test ends";
    case BUDGET_TEST_UNKNOWN:
      return "I could not check whether a budget test is running on it";
    case BUDGET_TEST_REVERT: {
      const on = dayWords(a);
      const base = Number(b);
      const back = Number.isFinite(base) && base > 0 ? `back to its ${usd(base)} a day baseline` : "back to its baseline";
      return `its budget test ended${on ? ` on ${on}` : ""}, so this puts it ${back}; nothing changes until you approve it`;
    }
    default:
      return null;
  }
}
