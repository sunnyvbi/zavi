import { z } from "zod";
import {
  xDaily,
  xId,
  xName,
  xTime,
  xTotal,
  xTweetIds,
  X_OBJECTIVES,
} from "./schema";

export const xLineChanges = z
  .object({
    name: xName.optional(),
    entity_status: z.enum(["PAUSED", "ACTIVE"]).optional(),
    bid_strategy: z.enum(["AUTO", "MAX", "TARGET"]).optional(),
    bid_amount: z.number().positive().max(10000).optional(),
    start_time: xTime.optional(),
    end_time: xTime.optional(),
    daily_budget: xDaily.optional(),
    total_budget: xTotal.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Provide at least one change");
const identity = { account_id: xId, campaign_id: xId };
const line = { ...identity, line_item_id: xId };
export const managementInput = z.discriminatedUnion("operation", [
  z.object({ ...identity, operation: z.literal("delete_campaign") }),
  z.object({
    ...identity,
    operation: z.literal("create_ad_group"),
    name: xName,
    objective: z.enum(X_OBJECTIVES),
    start_time: xTime,
    end_time: xTime,
  }),
  z.object({
    ...line,
    operation: z.literal("update_ad_group"),
    changes: xLineChanges,
  }),
  z.object({ ...line, operation: z.literal("delete_ad_group") }),
  z.object({
    ...line,
    operation: z.literal("add_promoted_ads"),
    tweet_ids: xTweetIds,
  }),
  z.object({
    ...line,
    operation: z.literal("remove_promoted_ad"),
    promoted_tweet_id: xId,
  }),
  z.object({
    ...line,
    operation: z.literal("add_target"),
    targeting_type: z.enum([
      "LOCATION",
      "BROAD_KEYWORD",
      "EXACT_KEYWORD",
      "PHRASE_KEYWORD",
      "UNORDERED_KEYWORD",
      "SIMILAR_TO_FOLLOWERS_OF_USER",
      "FOLLOWERS_OF_USER",
      "LANGUAGE",
      "INTEREST",
      "GENDER",
    ]),
    targeting_value: z.string().trim().min(1).max(200),
    operator_type: z.enum(["EQ", "NE"]),
  }),
  z.object({
    ...line,
    operation: z.literal("remove_target"),
    targeting_criterion_id: xId,
  }),
]);
export const managementBody = z.object({
  request: managementInput,
  before: z.object({
    campaign_updated_at: xTime,
    object_updated_at: xTime.nullable(),
    parent_updated_at: xTime.nullable(),
  }),
  name: xName,
  currency: z.string().nullable(),
  rationale: z.string().min(1),
  summary: z.string(),
  exact_change: z.object({
    rows: z.array(
      z.object({ item: z.string(), before: z.string(), after: z.string() }),
    ),
  }),
});
export type XManagementInput = z.infer<typeof managementInput>;
export const X_MANAGE_CLASS = "x_ads.manage_objects";
