import { z } from "zod";
import type { ToolSpec } from "@/services/tools/types";
import { redditId, redditLevel } from "@/services/connectors/reddit-ads/identifiers";
import { ownedAccount, getObject, listObjects, pages, endpoint } from "@/services/connectors/reddit-ads/adapter";
import { CONVERSION_EVENTS, readiness } from "@/services/connectors/reddit-ads/readiness";
import { performance } from "@/services/connectors/reddit-ads/reporting";
import { readRedditAutopilotState } from "@/services/connectors/reddit-ads/autopilot-state";

const conversionEvent = z.enum(CONVERSION_EVENTS);
const readinessInput = z.object({ ad_account_id: redditId, pixel_id: redditId.optional(), conversion_event: conversionEvent.optional() }).strict();
const reportInput = z.object({ ad_account_id: redditId, level: redditLevel.default("campaign"), days: z.number().int().min(1).max(90).default(7), conversion_event: conversionEvent.optional() }).strict();
const objectsInput = z.object({ ad_account_id: redditId, level: redditLevel, object_id: redditId.optional() }).strict();
const communityName = z.string().regex(/^[A-Za-z0-9_]{1,64}$/);
const targetingInput = z.discriminatedUnion("kind", [
  z.object({ ad_account_id: redditId, kind: z.literal("geolocations"), country: z.string().regex(/^[A-Z]{2}$/).optional(), postal_code: z.string().regex(/^[A-Za-z0-9 -]{1,16}$/).optional(), cities_search: z.string().min(1).max(100).optional() }).strict(),
  z.object({ ad_account_id: redditId, kind: z.literal("communities"), names: z.array(communityName).min(1).max(100).optional() }).strict(),
  z.object({ ad_account_id: redditId, kind: z.literal("interests") }).strict(),
]);
type TargetingInput = z.infer<typeof targetingInput>;

function targetingArgs(input: TargetingInput): Record<string, unknown> {
  if (input.kind === "communities") return input.names ? { names: input.names.join(",") } : {};
  if (input.kind === "interests") return {};
  const args: Record<string, unknown> = {};
  if (input.country) args.country = input.country;
  if (input.postal_code) args.postal_code = input.postal_code;
  if (input.cities_search) args.cities_search = input.cities_search;
  return args;
}

export const redditReadTools: ToolSpec[] = [
  {
    name: "reddit_ads_check_readiness",
    effect: "read",
    description: "Check the tenant-owned Reddit Ads connection: verified read access, account approval, currency, timezone, creative profiles, pixels and, for a chosen pixel and event, whether that event fired in the last seven days. " +
      "Also `autopilot`: the account's operating authority (granted, expired, none) with its limits, the workspace's active goals and this run's goal (an authorization needs a goal_id), open launch-path cards, campaigns prepared and not turned on, Zavi campaigns running, and `next`: the one card the facts allow now. " +
      "Write and CAPI permissions stay unverified; this check changes nothing in the account.",
    input_schema: readinessInput,
    async execute(ctx, input) {
      const b = readinessInput.parse(input);
      const r = await readiness(ctx.tenant_id, b.ad_account_id, b.pixel_id, b.conversion_event);
      return { ...r, autopilot: await readRedditAutopilotState(ctx.tenant_id, b.ad_account_id, ctx.run_id) };
    },
  },
  {
    name: "reddit_ads_read_performance",
    effect: "read",
    description: "Read paginated campaign, ad group or ad spend, impressions, clicks, separate signups, leads, purchases and purchase revenue in the account's timezone. Today is provisional; reports can lag six hours and conversions arrive later. Name the campaign's goal event and judge it on that event only; never add conversion types together.",
    input_schema: reportInput,
    async execute(ctx, input) {
      const b = reportInput.parse(input);
      return performance(ctx.tenant_id, b.ad_account_id, b.days, b.level, b.conversion_event);
    },
  },
  {
    name: "reddit_ads_read_objects",
    effect: "read",
    description: "Read owned campaigns, ad groups or ads with their relationships, configured status, effective delivery status, budget, targeting, creative IDs and modified_at. An enabled object can still be in review or not delivering.",
    input_schema: objectsInput,
    async execute(ctx, input) {
      const b = objectsInput.parse(input);
      const { account } = await ownedAccount(ctx.tenant_id, b.ad_account_id);
      if (b.object_id) return getObject(account, b.ad_account_id, b.level, b.object_id);
      return listObjects(account, b.ad_account_id, b.level);
    },
  },
  {
    name: "reddit_ads_list_targeting",
    effect: "read",
    description: "Read the Reddit targeting catalogue for an owned account: geolocations, communities or interests with their IDs. Research community suitability separately; this is the ID lookup, not the judgement.",
    input_schema: targetingInput,
    async execute(ctx, input) {
      const b = targetingInput.parse(input);
      const { account } = await ownedAccount(ctx.tenant_id, b.ad_account_id);
      return pages(account, `LIST_${b.kind.toUpperCase()}`, targetingArgs(b), endpoint("targeting", b.kind));
    },
  },
];
