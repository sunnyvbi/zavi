import { redditAdsAccount, listAdAccounts, listObjects, getPost } from "@/services/connectors/reddit-ads/adapter";
import { addMedia, emptyThumbnails, inGroups, stringId } from "./media";

export async function redditCampaignMedia(tenantId: string, ids: readonly string[]) {
  const result = emptyThumbnails(ids);
  const account = await redditAdsAccount(tenantId);
  const accounts = await listAdAccounts(account);
  await inGroups(accounts, async (advertiser) => {
    const [ads, groups] = await Promise.all([listObjects(account, advertiser.id, "ad"), listObjects(account, advertiser.id, "ad_group")]);
    const campaigns = new Map(groups.map((group) => [group.id, group.campaign_id]));
    const posts = new Map<string, Set<string>>();
    const references = new Map<string, number>();
    for (const ad of ads) {
      const campaign = ad.campaign_id ?? (ad.ad_group_id ? campaigns.get(ad.ad_group_id) : undefined);
      if (!campaign || !result[campaign]) continue;
      addMedia(result, campaign, ad);
      const postId = stringId(ad.post_id);
      if ((references.get(campaign) ?? 0) < 3 && postId && !posts.get(postId)?.has(campaign) && /^t3_[\da-z]+$/i.test(postId)) { references.set(campaign, (references.get(campaign) ?? 0) + 1); const owners = posts.get(postId) ?? new Set<string>(); owners.add(campaign); posts.set(postId, owners); }
    }
    await inGroups([...posts], async ([postId, owners]) => {
      const post = await getPost(account, postId);
      for (const campaign of owners) addMedia(result, campaign, post);
    });
  }, 2);
  return result;
}
