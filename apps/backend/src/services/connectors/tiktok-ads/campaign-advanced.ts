import { z } from "zod";
import type { OwnedComposioAccount } from "@/services/connectors/composio/api";
import { ExpectedToolError } from "@/services/tools/types";
import { tt } from "./composio-read";

const ids = z.array(z.string().regex(/^\d{1,32}$/)).max(100);
export const advancedGroupShape = {
  audience_ids: ids.optional(), excluded_audience_ids: ids.optional(), interest_category_ids: ids.optional(),
  operating_systems: z.array(z.enum(["IOS", "ANDROID"])).max(1).optional(),
  network_types: z.array(z.enum(["WIFI", "2G", "3G", "4G", "5G"])).max(5).optional(),
  dayparting: z.string().regex(/^[01]{336}$/, "Choose a weekly schedule in half-hour intervals.").optional(),
  comment_disabled: z.boolean().optional(), share_disabled: z.boolean().optional(),
  smart_audience_enabled: z.boolean().optional(), smart_interest_behavior_enabled: z.boolean().optional(),
  bid_type: z.enum(["BID_TYPE_NO_BID", "BID_TYPE_CUSTOM"]).optional(),
  bid_price: z.number().finite().positive().max(100000).optional(),
};
export const advancedGroupSchema = z.object(advancedGroupShape).strict();
export type AdvancedGroup = z.infer<typeof advancedGroupSchema>;
export const advancedGroupKeys = Object.keys(advancedGroupShape);
export const advancedGroupLabels: Record<string, string> = {
  audience_ids: "Included audiences", excluded_audience_ids: "Excluded audiences", interest_category_ids: "Interests",
  operating_systems: "Operating systems", network_types: "Connections", dayparting: "Weekly delivery schedule (account time)",
  comment_disabled: "Disable comments", share_disabled: "Disable sharing", smart_audience_enabled: "Smart Audience",
  smart_interest_behavior_enabled: "Smart interests and behaviors", bid_type: "Bid strategy", bid_price: "Bid price (account currency)",
};
const failure = (message: string): never => { throw new ExpectedToolError("tiktok_ads_targeting_unavailable", message); };
export type CampaignTargetingOption = { id: string; name: string };

export async function readCampaignAudiences(account: OwnedComposioAccount, advertiserId: string, wanted?: string[]): Promise<{ options: CampaignTargetingOption[]; truncated: boolean }> {
  const options: CampaignTargetingOption[] = [];
  for (let page = 1; page <= 20; page++) {
    const query = new URLSearchParams({ advertiser_id: advertiserId, page: String(page), page_size: "100" });
    if (wanted?.length) query.set("custom_audience_ids", JSON.stringify(wanted));
    const data = await tt(account, `/dmp/custom_audience/list/?${query}`);
    const parsed = z.object({ list: z.array(z.object({ custom_audience_id: z.string().regex(/^\d{1,32}$/), name: z.string().min(1), is_valid: z.boolean(), audience_sub_type: z.string().nullish() })), page_info: z.object({ total_page: z.number().int().nonnegative() }).optional() }).safeParse(data);
    if (!parsed.success) return failure("TikTok's audience list could not be confirmed. Refresh before changing audiences.");
    options.push(...parsed.data.list.filter(a => a.is_valid && a.audience_sub_type !== "REACH_FREQUENCY").map(a => ({ id: a.custom_audience_id, name: a.name })));
    const pages = parsed.data.page_info?.total_page;
    if (pages === undefined && parsed.data.list.length === 100) return { options, truncated: true };
    if (pages === undefined || page >= pages) return { options, truncated: false };
  }
  return { options, truncated: true };
}

export async function readCampaignInterests(account: OwnedComposioAccount, advertiserId: string): Promise<CampaignTargetingOption[]> {
  const query = new URLSearchParams({ advertiser_id: advertiserId, language: "en" });
  const data = await tt(account, `/tool/interest_category/?${query}`);
  const parsed = z.object({ interest_categories: z.array(z.object({ interest_category_id: z.string().regex(/^\d{1,32}$/), interest_category_name: z.string().min(1), placements: z.array(z.string()).optional() })) }).safeParse(data);
  if (!parsed.success) return failure("TikTok's interest categories could not be confirmed. Refresh before changing interests.");
  return parsed.data.interest_categories.filter(c => !c.placements?.length || c.placements.includes("PLACEMENT_TIKTOK")).map(c => ({ id: c.interest_category_id, name: c.interest_category_name }));
}

export async function verifyAdvancedGroup(account: OwnedComposioAccount, advertiserId: string, changes: AdvancedGroup, before: Record<string, unknown> = {}): Promise<void> {
  if (!Object.keys(changes).length) return;
  const combined = { ...before, ...changes };
  const included = Array.isArray(combined.audience_ids) ? combined.audience_ids as string[] : [];
  const excluded = Array.isArray(combined.excluded_audience_ids) ? combined.excluded_audience_ids as string[] : [];
  if (included.some(id => excluded.includes(id))) failure("An audience cannot be both included and excluded.");
  const wanted = [...new Set([...(changes.audience_ids ?? []), ...(changes.excluded_audience_ids ?? [])])];
  if (wanted.length) {
    const available = new Set((await readCampaignAudiences(account, advertiserId, wanted)).options.map(a => a.id));
    if (wanted.some(id => !available.has(id))) failure("A selected audience is unavailable in this ad account. Refresh the audience list.");
  }
  if (changes.interest_category_ids?.length) {
    const available = new Set((await readCampaignInterests(account, advertiserId)).map(a => a.id));
    if (changes.interest_category_ids.some(id => !available.has(id))) failure("A selected interest is unavailable for TikTok placement. Refresh the interest list.");
  }
  if (changes.bid_type !== undefined || changes.bid_price !== undefined) {
    if (combined.bid_type === "BID_TYPE_CUSTOM" && !(typeof combined.bid_price === "number" && combined.bid_price > 0)) failure("Enter a positive CPC bid for the cost cap strategy.");
    if (changes.bid_price !== undefined && combined.bid_type !== "BID_TYPE_CUSTOM") failure("A CPC bid applies only to the cost cap strategy.");
  }
}

export function advancedGroupValues(input: Record<string, unknown>): AdvancedGroup {
  const parsed = advancedGroupSchema.parse(Object.fromEntries(advancedGroupKeys.filter(key => input[key] !== undefined).map(key => [key, input[key]])));
  return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, Array.isArray(value) ? [...new Set(value)].sort() : key === "dayparting" && value === "0".repeat(336) ? "1".repeat(336) : value])) as AdvancedGroup;
}

export function describeDayparting(value: unknown): string {
  if (value == null || value === "" || value === "0".repeat(336) || value === "1".repeat(336)) return "Every day, all day";
  if (typeof value !== "string" || !/^[01]{336}$/.test(value)) return "Schedule unavailable";
  const clock = (slot: number) => `${String(Math.floor(slot / 2)).padStart(2, "0")}:${slot % 2 ? "30" : "00"}`;
  return ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day, index) => {
    const slots = value.slice(index * 48, (index + 1) * 48), windows: string[] = [];
    for (let i = 0; i < 48; i++) if (slots[i] === "1") { const start = i; while (i < 48 && slots[i] === "1") i++; windows.push(`${clock(start)}–${clock(i)}`); }
    return `${day}: ${windows.join(", ") || "off"}`;
  }).join("; ");
}

export function advancedGroupMatches(actual: Record<string, unknown>, wanted: AdvancedGroup): boolean {
  return Object.entries(wanted).every(([key, value]) => {
    const normalize = (v: unknown) => Array.isArray(v) ? [...new Set(v)].sort() : key === "dayparting" && (v == null || v === "" || v === "0".repeat(336)) ? "1".repeat(336) : v;
    return JSON.stringify(normalize(actual[key])) === JSON.stringify(normalize(value));
  });
}
