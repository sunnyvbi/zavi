import { redditAdsAccount, listAdAccounts } from "./composio-read";
import { getObject, listObjects } from "./adapter";
import { patchObject } from "./writes";
import { ExpectedToolError } from "@/services/tools/types";

export async function pauseRedditBudgetObject(tenantId: string, objectId: string): Promise<void> {
  const account = await redditAdsAccount(tenantId);
  for (const selected of await listAdAccounts(account)) {
    const groups = await listObjects(account, selected.id, "ad_group");
    const group = groups.find((g) => g.id === objectId);
    if (group) {
      await getObject(account, selected.id, "ad_group", objectId);
      await patchObject(account, "ad_group", objectId, { configured_status: "PAUSED" });
      if ((await getObject(account, selected.id, "ad_group", objectId)).configured_status !== "PAUSED") throw new Error("Reddit did not confirm the budget-stop pause; its reservation is retained.");
      return;
    }
    if (groups.some((g) => g.campaign_id === objectId)) {
      await getObject(account, selected.id, "campaign", objectId);
      await patchObject(account, "campaign", objectId, { configured_status: "PAUSED" });
      if ((await getObject(account, selected.id, "campaign", objectId)).configured_status !== "PAUSED") throw new Error("Reddit did not confirm the campaign pause; its reservation is retained.");
      return;
    }
  }
  throw new ExpectedToolError("reddit_ads_object_not_owned", "Budget-stop object was not found in the tenant's Reddit ad accounts. Check it in Reddit Ads Manager.");
}
