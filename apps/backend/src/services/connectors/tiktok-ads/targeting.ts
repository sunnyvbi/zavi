import { z } from "zod";
import type { OwnedComposioAccount } from "@/services/connectors/composio/api";
import { ExpectedToolError } from "@/services/tools/types";

export const TIKTOK_AGE_GROUPS = ["AGE_18_24", "AGE_25_34", "AGE_35_44", "AGE_45_54", "AGE_55_100"] as const;
export const TIKTOK_GENDERS = ["GENDER_UNLIMITED", "GENDER_MALE", "GENDER_FEMALE"] as const;
export const tiktokAgeGroupsSchema = z.array(z.enum(TIKTOK_AGE_GROUPS)).max(TIKTOK_AGE_GROUPS.length);
export const tiktokGenderSchema = z.enum(TIKTOK_GENDERS);
export const tiktokLanguagesSchema = z.array(z.string().min(1).max(32).regex(/^[A-Za-z0-9_-]+$/)).max(50);
export const TIKTOK_AGE_NAMES: Record<string, string> = { AGE_18_24: "18-24", AGE_25_34: "25-34", AGE_35_44: "35-44", AGE_45_54: "45-54", AGE_55_100: "55+" };
export const TIKTOK_GENDER_NAMES: Record<string, string> = { GENDER_UNLIMITED: "All genders", GENDER_MALE: "Male", GENDER_FEMALE: "Female" };

type AudienceInput = {
  age_groups?: Array<(typeof TIKTOK_AGE_GROUPS)[number]>;
  gender?: (typeof TIKTOK_GENDERS)[number];
  languages?: string[];
};
const sorted = (xs: string[]) => [...new Set(xs)].sort();

export function normalizeTiktokAudience(input: AudienceInput) {
  return {
    age_groups: [...new Set(input.age_groups?.length ? input.age_groups : TIKTOK_AGE_GROUPS)].sort(),
    gender: input.gender ?? "GENDER_UNLIMITED",
    languages: sorted(input.languages ?? []),
  };
}

export function tiktokAudienceMatches(raw: Record<string, unknown>, approved: AudienceInput): boolean {
  const want = normalizeTiktokAudience(approved);
  if (!Array.isArray(raw.age_groups) || !raw.age_groups.every((v) => typeof v === "string")) return false;
  if (!Array.isArray(raw.languages) || !raw.languages.every((v) => typeof v === "string")) return false;
  const ages = sorted(raw.age_groups as string[]);
  const languages = sorted(raw.languages as string[]);
  return JSON.stringify(ages) === JSON.stringify(want.age_groups)
    && raw.gender === want.gender
    && JSON.stringify(languages) === JSON.stringify(want.languages);
}

export type TiktokTargetingOption = { id: string; name: string };

export async function readTiktokLanguages(account: OwnedComposioAccount, advertiserId: string): Promise<TiktokTargetingOption[]> {
  const { tt } = await import("./composio-read");
  const data = await tt(account, `/tool/language/?advertiser_id=${encodeURIComponent(advertiserId)}`);
  const parsed = z.object({ languages: z.array(z.object({ code: z.string().min(1), name: z.string().trim().min(1) })) }).safeParse(data);
  if (!parsed.success) throw new ExpectedToolError("tiktok_ads_bad_response", "TikTok returned an invalid language list. Try again later.");
  return parsed.data.languages.map((l) => ({ id: l.code, name: l.name }));
}

export async function verifyTiktokLanguages(account: OwnedComposioAccount, advertiserId: string, ids: string[]): Promise<TiktokTargetingOption[]> {
  const wanted = sorted(ids);
  if (!wanted.length) return [];
  const byId = new Map((await readTiktokLanguages(account, advertiserId)).map((l) => [l.id, l]));
  const missing = wanted.filter((id) => !byId.has(id));
  if (missing.length) throw new ExpectedToolError("tiktok_ads_language_not_allowed", `TikTok does not offer these languages: ${missing.join(", ")}. Pick languages from tiktok_ads_targeting_options, or leave languages empty for all languages.`);
  return wanted.map((id) => byId.get(id)!);
}

export async function readTiktokTargetingOptions(account: OwnedComposioAccount, advertiserId: string) {
  return {
    age_groups: TIKTOK_AGE_GROUPS.map((id) => ({ id, name: TIKTOK_AGE_NAMES[id] })),
    genders: TIKTOK_GENDERS.map((id) => ({ id, name: TIKTOK_GENDER_NAMES[id] })),
    languages: await readTiktokLanguages(account, advertiserId),
  };
}

export async function readTiktokTargetingForTenant(tenantId: string) {
  const { tiktokAdsAccount } = await import("./composio-read");
  const { ensureAdAccounts } = await import("./ad-accounts");
  const [account, state] = await Promise.all([tiktokAdsAccount(tenantId), ensureAdAccounts(tenantId)]);
  if (!state.selected_id) throw new ExpectedToolError("tiktok_ads_account_not_chosen", "No TikTok ad account is chosen for Zavi. Choose it on the TikTok Ads channel page.");
  return readTiktokTargetingOptions(account, state.selected_id);
}
