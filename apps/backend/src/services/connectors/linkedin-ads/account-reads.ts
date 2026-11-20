import { ExpectedToolError } from "@/services/tools/types";
import { withLinkedInAdsToken } from "./client";
import { LINKEDIN_ADS_UNREADABLE, linkedinAdsGet, type LinkedInPage, type RestliValue } from "./http";

const MAX_PAGES = 20;
const PAGE_SIZE = 100;

export const sponsoredAccountUrn = (accountId: string) => `urn:li:sponsoredAccount:${accountId}`;
export const campaignIdOfUrn = (urn: unknown): string | null => (typeof urn === "string" ? (/^urn:li:sponsoredCampaign:(\d{1,20})$/.exec(urn)?.[1] ?? null) : null);
export const msToIso = (ms: unknown): string | null => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null);

async function readEvery<T>(token: string, path: string, params: Record<string, RestliValue>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < MAX_PAGES; i++) {
    const start = i * PAGE_SIZE;
    const page: LinkedInPage<T> = await linkedinAdsGet<LinkedInPage<T>>(token, path, { ...params, start, count: PAGE_SIZE });
    if (!Array.isArray(page.elements)) throw new ExpectedToolError("linkedin_ads_bad_response", LINKEDIN_ADS_UNREADABLE);
    out.push(...page.elements);
    const total = page.paging?.total;
    if (page.elements.length < PAGE_SIZE || (typeof total === "number" && start + page.elements.length >= total)) return out;
  }
  throw new ExpectedToolError("linkedin_ads_read_incomplete", `LinkedIn returned more ${path} than Zavi reads in one call, so this list is incomplete and nothing is concluded from it.`);
}

async function searchEvery<T>(token: string, path: string, params: Record<string, RestliValue>): Promise<T[]> {
  const out: T[] = [];
  let pageToken: string | null = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page: LinkedInPage<T> = await linkedinAdsGet<LinkedInPage<T>>(token, path, pageToken ? { ...params, pageSize: PAGE_SIZE, pageToken } : { ...params, pageSize: PAGE_SIZE });
    if (!Array.isArray(page.elements)) throw new ExpectedToolError("linkedin_ads_bad_response", LINKEDIN_ADS_UNREADABLE);
    out.push(...page.elements);
    pageToken = page.metadata?.nextPageToken || null;
    if (!pageToken || !page.elements.length) return out;
  }
  throw new ExpectedToolError("linkedin_ads_read_incomplete", `LinkedIn returned more ${path} than Zavi reads in one call, so this list is incomplete and nothing is concluded from it.`);
}

export type LiInsightTag = { id?: number | string; account?: string };
export type LiInsightTagDomain = { domainName?: string; lastCallbackAt?: number; blocked?: boolean; account?: string };
export type LiConversion = {
  id?: number | string;
  name?: string;
  type?: string;
  enabled?: boolean;
  lastCallbackAt?: number;
  latestFirstPartyCallbackAt?: number;
  associatedCampaigns?: Array<{ campaign?: string; associatedAt?: number } | string>;
  attributionType?: string;
  account?: string;
};
export type LiTargetTemplate = { id?: number | string; name?: string; description?: string; targetingCriteria?: unknown; approximateMemberCount?: number; created?: number; lastModified?: number; account?: string };
export type LiCampaignTargeting = { id?: number | string; name?: string; status?: string; targetingCriteria?: unknown; locale?: { country?: string; language?: string } };

export const readLinkedInInsightTagsWithToken = (token: string, accountId: string) => readEvery<LiInsightTag>(token, "insightTags", { q: "account", account: sponsoredAccountUrn(accountId) });
export const readLinkedInInsightTagDomainsWithToken = (token: string, accountId: string) => readEvery<LiInsightTagDomain>(token, "insightTagDomains", { q: "account", account: sponsoredAccountUrn(accountId) });
export const readLinkedInConversionsWithToken = (token: string, accountId: string) => readEvery<LiConversion>(token, "conversions", { q: "account", account: sponsoredAccountUrn(accountId) });
export const listLinkedInSavedAudiencesWithToken = (token: string, accountId: string) => readEvery<LiTargetTemplate>(token, "adTargetTemplates", { q: "account", account: sponsoredAccountUrn(accountId), sortField: "ID" });
export const readLinkedInCampaignTargetingWithToken = (token: string, accountId: string, statuses: readonly string[]) =>
  searchEvery<LiCampaignTargeting>(token, `adAccounts/${accountId}/adCampaigns`, { q: "search", search: { status: { values: [...statuses] } } });

export const readLinkedInInsightTags = (tenant_id: string, accountId: string) => withLinkedInAdsToken(tenant_id, (t) => readLinkedInInsightTagsWithToken(t, accountId));
export const readLinkedInInsightTagDomains = (tenant_id: string, accountId: string) => withLinkedInAdsToken(tenant_id, (t) => readLinkedInInsightTagDomainsWithToken(t, accountId));
export const readLinkedInConversions = (tenant_id: string, accountId: string) => withLinkedInAdsToken(tenant_id, (t) => readLinkedInConversionsWithToken(t, accountId));
export const listLinkedInSavedAudiences = (tenant_id: string, accountId: string) => withLinkedInAdsToken(tenant_id, (t) => listLinkedInSavedAudiencesWithToken(t, accountId));
export const readLinkedInCampaignTargeting = (tenant_id: string, accountId: string, statuses: readonly string[]) => withLinkedInAdsToken(tenant_id, (t) => readLinkedInCampaignTargetingWithToken(t, accountId, statuses));

export function associatedCampaignIds(c: LiConversion): string[] {
  return (c.associatedCampaigns ?? []).map((a) => campaignIdOfUrn(typeof a === "string" ? a : a?.campaign)).filter((id): id is string => id !== null);
}

export function canonicalTargeting(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      const items = v.map(walk);
      return items.every((i) => typeof i === "string") ? [...(items as string[])].sort() : items.map((i) => JSON.stringify(i)).sort().map((s) => JSON.parse(s));
    }
    if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, walk((v as Record<string, unknown>)[k])]));
    return v;
  };
  return JSON.stringify(walk(value) ?? null);
}
