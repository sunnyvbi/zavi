
import { isDraftActionType } from "./registry";

export const DEFAULT_TOP_N = 5;

export type RankableAction = {
  id: string;
  action_type?: string | null;
  blocking: boolean;
  position: number;
  score: number;
  proposed_at: string;
  status: string;
  snoozed_until: string | null;
};

export function isOpenAction(a: Pick<RankableAction, "status" | "snoozed_until">, nowMs: number): boolean {
  if (a.status === "pending") return true;
  if (a.status !== "snoozed") return false;
  const until = a.snoozed_until ? Date.parse(a.snoozed_until) : NaN;
  return !Number.isFinite(until) || until <= nowMs;
}

export function splitOverCap<T extends RankableAction>(
  ranked: readonly T[],
  topN: number = DEFAULT_TOP_N,
): { keep: T[]; over: T[] } {
  const n = Math.max(0, topN);
  const keep: T[] = [];
  const over: T[] = [];
  let drafts = 0;
  let chores = 0;
  for (const a of ranked) {
    const rank = isDraftActionType(a.action_type) ? ++drafts : ++chores;
    (rank <= n ? keep : over).push(a);
  }
  return { keep, over };
}

export function compareActions(a: RankableAction, b: RankableAction): number {
  if (a.blocking !== b.blocking) return a.blocking ? -1 : 1;
  const fa = a.position === 1;
  const fb = b.position === 1;
  if (fa !== fb) return fa ? -1 : 1;
  const sa = Number.isFinite(a.score) ? a.score : 0;
  const sb = Number.isFinite(b.score) ? b.score : 0;
  if (sa !== sb) return sb - sa;
  const ta = Date.parse(a.proposed_at);
  const tb = Date.parse(b.proposed_at);
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function rankActions<T extends RankableAction>(
  actions: readonly T[],
  opts: { nowMs: number; topN?: number; all?: boolean },
): { actions: T[]; more: number } {
  const open = actions.filter((a) => isOpenAction(a, opts.nowMs)).sort(compareActions);
  if (opts.all) return { actions: open, more: 0 };
  const { keep, over } = splitOverCap(open, opts.topN ?? DEFAULT_TOP_N);
  return { actions: keep, more: over.length };
}

export function rankChannelCards<T extends RankableAction>(
  cards: readonly T[],
  isStagedDraft: (card: T) => boolean,
): T[] {
  const group = (c: T): number => (c.blocking ? 0 : isStagedDraft(c) ? 1 : 2);
  return [...cards].sort((a, b) => {
    const ga = group(a);
    const gb = group(b);
    if (ga !== gb) return ga - gb;
    if (ga === 1) {
      const ta = Date.parse(a.proposed_at);
      const tb = Date.parse(b.proposed_at);
      if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return tb - ta;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    }
    return compareActions(a, b);
  });
}
