import { deliverableOf, exactChangeRows, type ActionItem } from "../types";

export type AdSectionId = "fix" | "ready" | "improve" | "completed";

export function adSection(action: ActionItem): AdSectionId {
  if (action.exec_status === "executed") return "completed";
  if (action.exec_status === "failed" && action.status !== "pending") return "completed";
  const intent = action.body?.intent ?? action.body?.step?.intent;
  if (action.blocking || intent === "fix_setup") return "fix";
  if (intent === "improve" && !action.executable && !action.body?.step?.deliverable) return "improve";
  return "ready";
}

export function partitionAds(actions: readonly ActionItem[]): Record<AdSectionId, ActionItem[]> {
  const sections: Record<AdSectionId, ActionItem[]> = { fix: [], ready: [], improve: [], completed: [] };
  for (const action of actions) sections[adSection(action)].push(action);
  return sections;
}

export function isAdTask(action: ActionItem): boolean {
  return !action.executable && action.action_type !== "create_ad" && !deliverableOf(action) && exactChangeRows(action).length === 0;
}
