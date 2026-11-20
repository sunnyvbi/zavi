import { listLinkedInAdAccountsRaw, withLinkedInAdsToken } from "@/services/connectors/linkedin-ads/client";
import { linkedinAdsBatchGet, linkedinAdsGet, linkedinCreativePath } from "@/services/connectors/linkedin-ads/http";
import { readPublicPostImage } from "@/services/connectors/linkedin-ads/post-link";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { addMedia, emptyThumbnails, inGroups, isRecord, stringId, type CampaignThumbnails } from "./media";

export function mediaReferences(value: unknown): string[] {
  const refs = new Set<string>();
  const visit = (node: unknown, depth: number) => {
    if (depth > 7 || refs.size >= 6) return;
    if (typeof node === "string" && /^urn:li:(image|video):[\w-]+$/.test(node)) refs.add(node);
    else if (Array.isArray(node)) node.slice(0, 30).forEach((child) => visit(child, depth + 1));
    else if (isRecord(node)) Object.values(node).slice(0, 50).forEach((child) => visit(child, depth + 1));
  };
  visit(value, 0);
  return [...refs];
}

async function tenantCampaignScope(tenantId: string): Promise<{ accounts: Set<string>; wallet: Set<string> } | null> {
  try {
    const db = tenantClient(asTenantId(tenantId));
    const [accounts, wallet] = await Promise.all([
      db.from("ads_account_binding_details").select("tenant_id, provider_account_id").eq("platform", "linkedin").range(0, 999),
      db.from("ads_campaign_binding_details").select("tenant_id, provider_campaign_id").eq("platform", "linkedin").eq("funding_source", "wallet").range(0, 999),
    ]);
    if (accounts.error || wallet.error || !Array.isArray(accounts.data) || !Array.isArray(wallet.data) || accounts.data.length === 1000 || wallet.data.length === 1000) return null;
    const own = <T extends { tenant_id: string }>(rows: T[]) => rows.filter((r) => r.tenant_id === tenantId);
    return {
      accounts: new Set(own(accounts.data as Array<{ tenant_id: string; provider_account_id: string | null }>).flatMap((r) => r.provider_account_id ?? [])),
      wallet: new Set(own(wallet.data as Array<{ tenant_id: string; provider_campaign_id: string | null }>).flatMap((r) => r.provider_campaign_id ?? [])),
    };
  } catch {
    return null;
  }
}

async function launchedCreatives(tenantId: string, campaigns: readonly string[]): Promise<Array<{ campaign: string; account: string; creative: string }>> {
  if (!campaigns.length) return [];
  try {
    const db = tenantClient(asTenantId(tenantId));
    const bindings = await db.from("ads_campaign_binding_details").select("id, tenant_id, account_binding_id, provider_campaign_id").eq("platform", "linkedin").in("provider_campaign_id", [...campaigns]).range(0, 999);
    const rows = ((bindings.data ?? []) as Array<{ id: string; tenant_id: string; account_binding_id: string | null; provider_campaign_id: string }>).filter((r) => r.tenant_id === tenantId);
    if (bindings.error || !rows.length) return [];
    const [lifecycle, accounts] = await Promise.all([
      db.from("ads_campaign_lifecycle").select("tenant_id, campaign_binding_id, provider_creative_ids").in("campaign_binding_id", rows.map((r) => r.id)).range(0, 999),
      db.from("ads_account_binding_details").select("id, tenant_id, provider_account_id").in("id", rows.flatMap((r) => r.account_binding_id ?? [])).range(0, 999),
    ]);
    if (lifecycle.error || accounts.error) return [];
    const creativeOf = new Map(((lifecycle.data ?? []) as Array<{ tenant_id: string; campaign_binding_id: string; provider_creative_ids: string[] | null }>).filter((r) => r.tenant_id === tenantId).map((r) => [r.campaign_binding_id, r.provider_creative_ids?.[0] ?? null]));
    const accountOf = new Map(((accounts.data ?? []) as Array<{ id: string; tenant_id: string; provider_account_id: string | null }>).filter((r) => r.tenant_id === tenantId).map((r) => [r.id, r.provider_account_id]));
    return rows.flatMap((r) => {
      const creative = creativeOf.get(r.id);
      const account = r.account_binding_id ? accountOf.get(r.account_binding_id) : null;
      return creative && account ? [{ campaign: r.provider_campaign_id, account, creative }] : [];
    });
  } catch {
    return [];
  }
}

export type CampaignMediaLevel = "campaign" | "ad";

export async function linkedinCampaignMedia(tenantId: string, ids: readonly string[], level: CampaignMediaLevel = "campaign") {
  const result = level === "ad" ? {} as CampaignThumbnails : emptyThumbnails(ids);
  const requested = new Set(ids);
  const { token, accounts } = await withLinkedInAdsToken(tenantId, async (t) => ({ token: t, accounts: await listLinkedInAdAccountsRaw(t) }));
  const posts = new Map<string, Set<string>>();
  const assets = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, id: string, campaign: string) => { if ([...map.values()].filter((owners) => owners.has(campaign)).length >= 3) return; const owners = map.get(id) ?? new Set<string>(); owners.add(campaign); map.set(id, owners); };
  const scope = await tenantCampaignScope(tenantId);
  const found = new Set<string>();
  const take = (creative: unknown) => {
    if (!isRecord(creative)) return;
    const campaign = stringId(creative.campaign)?.replace(/^urn:li:sponsoredCampaign:/, "");
    if (!campaign || !requested.has(campaign)) return;
    const key = level === "ad" ? stringId(creative.id)?.replace(/^urn:li:sponsoredCreative:/, "") : campaign;
    if (!key) return;
    found.add(campaign);
    result[key] ??= [];
    addMedia(result, key, creative);
    const ref = isRecord(creative.content) ? stringId(creative.content.reference) : null;
    if (ref && /^urn:li:(share|ugcPost):\d+$/.test(ref)) add(posts, ref, key);
    for (const asset of mediaReferences(creative)) add(assets, asset, key);
  };
  const readCreatives = (campaigns: readonly string[]) => async (account: { id: string }) => {
    let pageToken: string | undefined;
    for (let page = 0; page < 5; page++) {
      const data = await linkedinAdsGet<unknown>(token, `adAccounts/${account.id}/creatives`, { q: "criteria", campaigns: campaigns.map((id) => `urn:li:sponsoredCampaign:${id}`), pageSize: 100, ...(pageToken ? { pageToken } : {}) }, {}, { restliMethod: "FINDER" });
      if (!isRecord(data) || !Array.isArray(data.elements)) throw new Error("Unreadable LinkedIn creatives");
      for (const creative of data.elements) take(creative);
      pageToken = isRecord(data.metadata) ? stringId(data.metadata.nextPageToken) ?? undefined : undefined;
      if (!pageToken) break;
    }
  };
  await inGroups(scope ? accounts.filter((a) => scope.accounts.has(a.id)) : accounts, readCreatives(ids), 2);
  const unfound = ids.filter((id) => !found.has(id) && !scope?.wallet.has(id));
  if (scope && unfound.length) await inGroups(accounts.filter((a) => !scope.accounts.has(a.id)), readCreatives(unfound), 2);
  const launched = await launchedCreatives(tenantId, ids.filter((id) => !found.has(id) && !scope?.wallet.has(id)));
  await inGroups(launched, async ({ account, creative }) => {
    try {
      take(await linkedinAdsGet<unknown>(token, linkedinCreativePath(account, creative)));
    } catch (e) {
      if ((e as { code?: unknown })?.code === "linkedin_ads_token_revoked") throw e;
    }
  }, 3);
  let readPosts: Record<string, unknown> = {};
  try {
    readPosts = await linkedinAdsBatchGet(token, "posts", [...posts.keys()]);
  } catch (e) {
    if ((e as { code?: unknown })?.code === "linkedin_ads_token_revoked") throw e;
  }
  for (const [ref, post] of Object.entries(readPosts)) {
    for (const campaign of posts.get(ref) ?? []) {
      addMedia(result, campaign, post);
      for (const asset of mediaReferences(post)) add(assets, asset, campaign);
    }
  }
  const unreadPosts = [...posts.keys()].filter((ref) => !readPosts[ref] && [...(posts.get(ref) ?? [])].some((campaign) => !result[campaign]?.length));
  await inGroups(unreadPosts, async (ref) => {
    const url = await readPublicPostImage(ref);
    if (url) for (const campaign of posts.get(ref) ?? []) addMedia(result, campaign, { image_url: url });
  }, 3).catch(() => undefined);
  for (const kind of ["image", "video"] as const) {
    const refs = [...assets.keys()].filter((ref) => ref.startsWith(`urn:li:${kind}:`));
    for (const [ref, asset] of Object.entries(await linkedinAdsBatchGet(token, `${kind}s`, refs))) {
      const media = kind === "video" && isRecord(asset) ? { thumbnail_url: asset.thumbnail, thumbnailUrl: asset.thumbnailUrl, thumbnails: asset.thumbnails } : asset;
      for (const campaign of assets.get(ref) ?? []) addMedia(result, campaign, media);
    }
  }
  return result;
}
