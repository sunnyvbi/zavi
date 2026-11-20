import { CHECK_CARD_PREFIX } from "../agent/cardViews";
import type { ActionItem, PlatformSpec } from "./types";

export function channelCardPool(platform: PlatformSpec, payload: unknown, actions: ActionItem[], published: ReadonlySet<string>) {
  const projected = platform.stagedCards?.(payload, actions) ?? [];
  const storedIds = new Set(actions.map((action) => action.id));
  const paired = new Map(projected.filter((action) => storedIds.has(action.id)).map((action) => [action.id, action]));
  const extra = projected.filter((action) => !storedIds.has(action.id));
  const cards = actions.map((action) => paired.get(action.id) ?? action);
  const outdatedActions = platform.requireActionResponsibility ? cards.filter((action) => !action.executable && !action.body?.step?.responsibility) : [];
  const currentActions = cards.filter((action) => !outdatedActions.includes(action));
  const checks = extra.filter((action) => action.id.startsWith(CHECK_CARD_PREFIX));
  const staged = extra.filter((action) => !action.id.startsWith(CHECK_CARD_PREFIX) && !published.has(action.id));
  return {
    checks,
    staged,
    stagedIds: new Set(staged.map((action) => action.id)),
    liveIds: new Set([...extra.map((action) => action.id), ...cards.flatMap((action) => action.staged_draft_id ? [action.staged_draft_id] : [])]),
    outdatedActions,
    operatorNotes: currentActions.filter((action) => action.body?.step?.responsibility === "zavi"),
    customerActions: currentActions.filter((action) => action.body?.step?.responsibility !== "zavi"),
  };
}
