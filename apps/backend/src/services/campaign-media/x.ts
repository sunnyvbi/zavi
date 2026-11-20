import { listXAdAccountsRaw, xAdsRequest, xAdsTenantToken } from "@/services/connectors/x-ads/client";
import { listXResources, type XLineItem } from "@/services/connectors/x-ads/resources";
import { addMedia, emptyThumbnails, inGroups, isRecord, stringId } from "./media";

interface PromotedPost { id: string; line_item_id?: string; tweet_id?: string; }

export async function xCampaignMedia(tenantId: string, ids: readonly string[]) {
  const result = emptyThumbnails(ids);
  const token = await xAdsTenantToken(tenantId);
  const accounts = (await listXAdAccountsRaw(token)).slice(0, 5);
  await inGroups(accounts, async (account) => {
    const groups = (await listXResources<XLineItem>(token, account.id, "line_items", { campaign_ids: ids.join(",") })).filter((group) => Object.hasOwn(result, group.campaign_id));
    if (!groups.length) return;
    const campaigns = new Map(groups.map((group) => [group.id, group.campaign_id]));
    const posts = await listXResources<PromotedPost>(token, account.id, "promoted_tweets", { line_item_ids: groups.map((group) => group.id).join(",") });
    const owners = new Map<string, Set<string>>();
    for (const post of posts) {
      const campaign = post.line_item_id ? campaigns.get(post.line_item_id) : undefined;
      if (!campaign || !post.tweet_id || [...owners.values()].filter((targets) => targets.has(campaign)).length >= 3) continue;
      addMedia(result, campaign, post);
      const targets = owners.get(post.tweet_id) ?? new Set<string>(); targets.add(campaign); owners.set(post.tweet_id, targets);
    }
    const tweets = [...owners.keys()];
    for (let offset = 0; offset < tweets.length; offset += 100) {
      const data = await xAdsRequest<unknown>(token, "GET", `accounts/${account.id}/tweets`, { tweet_ids: tweets.slice(offset, offset + 100).join(","), tweet_type: "PUBLISHED", trim_user: "true", include_entities: "true" });
      if (!isRecord(data) || !Array.isArray(data.data)) throw new Error("Unreadable promoted posts");
      for (const post of data.data) {
        if (!isRecord(post)) continue;
        const id = stringId(post.id_str) ?? stringId(post.id);
        for (const campaign of id ? owners.get(id) ?? [] : []) addMedia(result, campaign, { extended_entities: post.extended_entities, entities: post.entities, card: post.card });
      }
    }
  }, 2);
  return result;
}
