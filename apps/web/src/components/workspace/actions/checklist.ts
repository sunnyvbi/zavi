
import type { ExtraTableData } from "./ExtraTable";

export type CheckState = "fail" | "unknown" | "pass";

export function checklistOrder<T>(items: readonly T[], state: (t: T) => CheckState): { item: T; tail: boolean }[] {
  const rank: Record<CheckState, number> = { fail: 0, unknown: 1, pass: 2 };
  return items
    .map((item, i) => ({ item, i, s: state(item) }))
    .sort((a, b) => rank[a.s] - rank[b.s] || a.i - b.i)
    .map(({ item, s }) => ({ item, tail: s === "pass" }));
}

export function topRows<R extends { tail?: boolean }>(rows: readonly R[], n = 3): R[] {
  return rows.map((r, i) => (i < n ? r : { ...r, tail: true }));
}

export function topTail(total: number, n = 3): NonNullable<ExtraTableData["tailToggle"]> {
  return { show: () => "Show more", hide: "Show less", noneAbove: "" };
}

export const PASSING_TAIL: NonNullable<ExtraTableData["tailToggle"]> = {
  show: () => "Show more",
  hide: "Show less",
  noneAbove: "Every check passes.",
};
