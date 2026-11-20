import { z } from "zod";
import { tiktokAgeGroupsSchema, tiktokGenderSchema, tiktokLanguagesSchema } from "./targeting";
import { TIKTOK_LAUNCH_CTAS, TIKTOK_MAX_LOCATIONS } from "./launch-schema";
import { advancedGroupShape } from "./campaign-advanced";

export const TIKTOK_UPDATE_SETTINGS_CLASS = "tiktok_ads.update_settings";
const id = z.string().regex(/^\d{1,32}$/);
const name = z.string().trim().min(1).max(512);
const instant = z.string().datetime({ offset: true });
const campaignChanges = z.object({ campaign_name: name.optional() }).strict();
const groupChanges = z.object({
  ...advancedGroupShape,
  adgroup_name: name.optional(),
  location_ids: z.array(id).min(1).max(TIKTOK_MAX_LOCATIONS).optional(),
  age_groups: tiktokAgeGroupsSchema.optional(),
  gender: tiktokGenderSchema.optional(),
  languages: tiktokLanguagesSchema.optional(),
  schedule_start_time: instant.optional(),
  schedule_end_time: instant.optional(),
}).strict();
const adChanges = z.object({
  ad_name: name.optional(),
  ad_text: z.string().trim().min(1).max(100).optional(),
  landing_page_url: z.string().url().max(2000).refine(v => v.startsWith("https://"), "Use an https destination.").optional(),
  call_to_action: z.enum(TIKTOK_LAUNCH_CTAS).optional(),
  video_id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/).optional(),
  aigc_disclosure_type: z.enum(["SELF_DISCLOSURE", "NOT_DECLARED"]).optional(),
}).strict();
const target = { advertiser_id: id, campaign_id: id, object_id: id, revision: z.string().regex(/^[0-9a-f]{64}$/) };
const levels = [
  z.object({ ...target, level: z.literal("campaign"), changes: campaignChanges }).strict(),
  z.object({ ...target, level: z.literal("ad_group"), changes: groupChanges }).strict(),
  z.object({ ...target, level: z.literal("ad"), changes: adChanges }).strict(),
] as const;
export const settingsChangeInput = z.discriminatedUnion("level", levels)
  .refine(v => Object.keys(v.changes).length > 0, "Choose a setting to change.")
  .refine(v => v.level !== "campaign" || v.object_id === v.campaign_id, "Campaign IDs do not agree.");
export type SettingsChangeInput = z.infer<typeof settingsChangeInput>;
const value = z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]);
const bodyCommon = {
  advertiser_name: z.string().min(1).max(300),
  name: z.string().min(1).max(512),
  ad_group_id: id.nullable(),
  daily_budget_usd: z.number().nonnegative().nullable(),
  before: z.record(z.string(), value),
  location_names: z.record(id, z.string().trim().min(1).max(1000)).optional(),
  origin: z.literal("user_initiated_ledger"),
  rationale: z.string().min(1).max(1000),
};
export const tiktokSettingsBody = z.discriminatedUnion("level", [
  levels[0].extend(bodyCommon), levels[1].extend(bodyCommon), levels[2].extend(bodyCommon),
]).refine(v => Object.keys(v.changes).length > 0, "Choose a setting to change.")
  .refine(v => v.level === "campaign" ? v.object_id === v.campaign_id && v.ad_group_id === null : v.level === "ad_group" ? v.object_id === v.ad_group_id : v.ad_group_id !== null, "Object lineage does not agree.");
export type TiktokSettingsBody = z.infer<typeof tiktokSettingsBody>;
export type SettingsLevel = SettingsChangeInput["level"];
export type SettingsValue = z.infer<typeof value>;
