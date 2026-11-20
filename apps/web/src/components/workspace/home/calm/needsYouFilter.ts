
import { isHighStakesDecision } from "@/app/approvals/approvalsHelpers";

export type NeedsYouDecision = {
  id: string;
  decision_class: string;
  handler: string | null;
  body: Record<string, unknown>;
  emitted_at: string;
};

export const MAX_SHOWN = 5;

export type NeedsYouResult<T extends NeedsYouDecision> = {
  shown: T[];
  total: number;
  hidden: number;
};

function ts(iso: string): number {
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : 0;
}

export function filterNeedsYou<T extends NeedsYouDecision>(
  decisions: T[],
  max: number = MAX_SHOWN,
): NeedsYouResult<T> {
  const sorted = [...decisions].sort((a, b) => {
    const aHigh = isHighStakesDecision(a.decision_class, a.handler, a.body);
    const bHigh = isHighStakesDecision(b.decision_class, b.handler, b.body);
    if (aHigh !== bHigh) return aHigh ? -1 : 1;
    return ts(b.emitted_at) - ts(a.emitted_at);
  });
  const shown = sorted.slice(0, Math.max(0, max));
  return { shown, total: decisions.length, hidden: decisions.length - shown.length };
}
