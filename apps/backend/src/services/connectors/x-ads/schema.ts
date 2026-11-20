import { z } from "zod";
import { ExpectedToolError } from "@/services/tools/types";

export const X_MAX_DAILY_BUDGET = 10_000;
export const X_MAX_TOTAL_BUDGET = 1_000_000;
export const X_OBJECTIVES = ["WEBSITE_CLICKS", "ENGAGEMENTS", "REACH", "FOLLOWERS", "VIDEO_VIEWS"] as const;

export const X_ID_RE = /^[a-z0-9]{1,32}$/;
export const X_TWEET_ID_RE = /^[0-9]{1,25}$/;
export const X_LOCATION_ID_RE = /^[A-Za-z0-9]{1,64}$/;

export const xId = z.string().regex(X_ID_RE, "must be an X Ads id (base-36)");
export const xName = z.string().trim().min(1).max(255);
export const xDaily = z.number().positive().max(X_MAX_DAILY_BUDGET);
export const xTotal = z.number().positive().max(X_MAX_TOTAL_BUDGET);
export const xTime = z.string().datetime({ offset: true });
export const xTweetIds = z.array(z.string().regex(X_TWEET_ID_RE, "a post id is digits only")).min(1).max(10);
export const xLocations = z.array(z.object({ id: z.string().regex(X_LOCATION_ID_RE), name: z.string().min(1).max(200) })).max(25);

export const X_AGE_BUCKETS = [
  "AGE_18_TO_24", "AGE_18_TO_34", "AGE_18_TO_49", "AGE_18_TO_54", "AGE_18_AND_OVER",
  "AGE_21_TO_34", "AGE_21_TO_49", "AGE_21_TO_54", "AGE_21_AND_OVER",
  "AGE_25_TO_49", "AGE_25_TO_54", "AGE_25_AND_OVER",
  "AGE_35_TO_49", "AGE_35_TO_54", "AGE_35_AND_OVER", "AGE_50_AND_OVER",
] as const;
export const X_GENDERS = ["MALE", "FEMALE"] as const;
export const X_LANGUAGE_RE = /^[a-z]{2}$/;
export const xKeywords = z.array(z.string().trim().min(1).max(100)).max(50);
export const xLanguages = z.array(z.string().regex(X_LANGUAGE_RE)).max(10);
export const xGenders = z.array(z.enum(X_GENDERS)).max(2);
export const xAges = z.array(z.enum(X_AGE_BUCKETS)).max(4);
export const EMPTY_AUDIENCE = { keywords: [] as string[], languages: [] as string[], genders: [] as ("MALE" | "FEMALE")[], ages: [] as (typeof X_AGE_BUCKETS)[number][] };
export const xAudience = z.object({
  keywords: xKeywords.optional().default([]),
  languages: xLanguages.optional().default([]),
  genders: xGenders.optional().default([]),
  ages: xAges.optional().default([]),
});
export type XAudience = z.infer<typeof xAudience>;
export const X_POST_MAX_CHARS = 280;
export const X_URL_RE = /https?:\/\/\S+/gi;
export function xPostLength(text: string): number {
  return text.replace(X_URL_RE, "x".repeat(23)).length;
}
export const xPostText = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .refine((t) => xPostLength(t) <= X_POST_MAX_CHARS, { message: `a post is at most ${X_POST_MAX_CHARS} characters (a link counts 23)` });
export const xNewPost = z.object({ text: xPostText });
export const xDurationDays = z.number().int().min(1).max(365);

export const X_AUDIENCE_LABELS: Record<string, string> = {
  MALE: "Men", FEMALE: "Women",
  AGE_18_TO_24: "18 to 24", AGE_18_TO_34: "18 to 34", AGE_18_TO_49: "18 to 49", AGE_18_TO_54: "18 to 54", AGE_18_AND_OVER: "18 and over",
  AGE_21_TO_34: "21 to 34", AGE_21_TO_49: "21 to 49", AGE_21_TO_54: "21 to 54", AGE_21_AND_OVER: "21 and over",
  AGE_25_TO_49: "25 to 49", AGE_25_TO_54: "25 to 54", AGE_25_AND_OVER: "25 and over",
  AGE_35_TO_49: "35 to 49", AGE_35_TO_54: "35 to 54", AGE_35_AND_OVER: "35 and over", AGE_50_AND_OVER: "50 and over",
};
export const audienceLabel = (v: string) => X_AUDIENCE_LABELS[v] ?? v;

const exactChange = z.object({ rows: z.array(z.object({ item: z.string(), before: z.string(), after: z.string() })) });
const card = { currency: z.string().nullable(), rationale: z.string(), summary: z.string(), exact_change: exactChange };

export const statusBody = z.object({
  account_id: xId,
  campaign_id: xId,
  name: xName,
  status: z.enum(["PAUSED", "ACTIVE"]),
  daily_budget: z.number().nullable(),
  total_budget: z.number().nullable().optional(),
  ...card,
});

export const updateBody = z.object({
  account_id: xId,
  campaign_id: xId,
  name: xName,
  changes: z
    .object({ name: xName.optional(), daily_budget: xDaily.optional(), total_budget: xTotal.optional() })
    .refine((c) => Object.keys(c).length > 0, "no change"),
  before: z.object({ name: xName, daily_budget: z.number().nullable(), total_budget: z.number().nullable() }),
  ...card,
});

export const createBody = z.object({
  account_id: xId,
  funding_instrument_id: xId,
  name: xName,
  objective: z.enum(X_OBJECTIVES),
  daily_budget: xDaily,
  total_budget: xTotal.nullable(),
  tweet_ids: z.array(z.string().regex(X_TWEET_ID_RE, "a post id is digits only")).max(10),
  new_post: xNewPost.nullable().optional().default(null),
  locations: xLocations,
  excluded_locations: xLocations.optional().default([]),
  audience: xAudience.optional().default(EMPTY_AUDIENCE),
  start_time: xTime,
  end_time: xTime.nullable(),
  duration_days: xDurationDays.nullable().optional().default(null),
  launch: z.enum(["PAUSED", "ACTIVE"]),
  ...card,
})
  .refine((b) => b.tweet_ids.length > 0 || b.new_post !== null, { message: "a campaign promotes existing posts or one new post", path: ["tweet_ids"] })
  .refine((b) => b.end_time === null || b.duration_days === null, { message: "an end time or a duration, not both", path: ["duration_days"] });

export type ExactRow = z.infer<typeof exactChange>["rows"][number];
export type XStatusBody = z.infer<typeof statusBody>;
export type XUpdateBody = z.infer<typeof updateBody>;
export type XCreateBody = z.infer<typeof createBody>;

export function assertBudgetOrder(daily: number | null, total: number | null): void {
  if (daily !== null && total !== null && daily > total) {
    throw new ExpectedToolError("x_ads_budget_invalid", "The daily budget cannot be more than the total budget.");
  }
}

export function money(amount: number | null, currency: string | null): string {
  if (amount === null) return "none";
  const n = amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency === "USD" || !currency ? `$${n}` : `${n} ${currency}`;
}

export const isoNow = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

export function xActionRaisesSpend(cls: string | undefined, body: unknown): boolean {
  type Obj = Record<string, unknown>;
  const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
  const b = obj(body);
  const up = (to: unknown, from: unknown) =>
    to !== undefined && !(from != null && Number.isFinite(Number(to)) && Number.isFinite(Number(from)) && Number(to) <= Number(from));
  if (cls === "x_ads.create_campaign") return b.launch !== "PAUSED";
  if (cls === "x_ads.set_status") return b.status !== "PAUSED";
  if (cls === "x_ads.update_campaign") {
    if (!b.changes) return true;
    const c = obj(b.changes), before = obj(b.before);
    return up(c.daily_budget, before.daily_budget) || up(c.total_budget, before.total_budget);
  }
  if (cls === "x_ads.manage_objects") {
    const r = obj(b.request);
    if (r.operation !== "update_ad_group") return typeof r.operation !== "string";
    const c = obj(r.changes);
    return c.entity_status === "ACTIVE" || ["daily_budget", "total_budget", "bid_amount", "bid_strategy", "start_time", "end_time"].some((k) => c[k] !== undefined);
  }
  return true;
}
