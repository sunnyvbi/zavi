import { noCommittedAdSpendHold, releaseAdSpendForObject } from "@/services/decisions/ad-budget";
import { logEvent } from "@/services/logging/logEvent";
import { listObjects, type RedditAccount, type RedditObject } from "./adapter";
import type { RedditLevel } from "./identifiers";

export const HOLD_KEPT_NOTE = " Zavi could not confirm its budget hold was released, so it may still count against your ad budget for now; Zavi has been alerted to check it.";
export async function releaseRedditHolds(tenantId: string, account: RedditAccount, accountId: string, level: RedditLevel, objectId: string): Promise<boolean> {
  const once = async (id: string) => {
    if (!(await releaseAdSpendForObject(tenantId, "reddit", id))) return false;
    return (await noCommittedAdSpendHold(tenantId, "reddit", id)) ?? (await noCommittedAdSpendHold(tenantId, "reddit", id)) ?? false;
  };
  let ok = await once(objectId);
  if (level === "campaign") {
    let groups: RedditObject[] | null = null;
    try { groups = (await listObjects(account, accountId, "ad_group")).filter((g) => g.campaign_id === objectId); } catch { groups = null; }
    if (!groups) ok = false;
    else for (const group of groups) ok = (await once(group.id)) && ok;
  }
  if (!ok) await logEvent({ level: "error", source: "reddit-ads", code: "reddit_ads.hold_release_unconfirmed", tenant_id: tenantId, meta: { stage: level } });
  return ok;
}
