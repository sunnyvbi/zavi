
import { z } from "zod";
import { rationaleInput } from "@/services/tools/_shared/rationale";
import type { ToolSpec, ToolContext } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import { isHumanAuthoredCommand } from "@/services/agents/untrusted-context";
import { isMetaAdsWriteEnabled } from "./_flag-check";
import { metaBidStrategySchema, normalizeMetaTime, updateAdBodySchema, updateAdSetBodySchema } from "./_decision-bodies";
import { fbGet, getAdAccountCurrency } from "../_client";
import { minorToMajor } from "./_currency";
import { readOwnAdSet, targetingFingerprint } from "./adset_ad_writes";

type Emit = (decision_class: string, body: unknown) => Promise<string>;

async function preflight(ctx: ToolContext): Promise<Emit> {
  if (!(await isMetaAdsWriteEnabled())) {
    throw new ExpectedToolError("meta_ads_write_disabled", "Meta Ads write is disabled at the platform level.");
  }
  if (typeof ctx.emit_decision !== "function") {
    throw new ExpectedToolError("meta_ads_propose_no_emit", "Cannot emit a decision in this context (no emit_decision plumbed).");
  }
  return ctx.emit_decision;
}

function originOf(ctx: ToolContext): { origin: "user_initiated_chat" } | Record<string, never> {
  return isHumanAuthoredCommand(ctx, "budget") ? { origin: "user_initiated_chat" } : {};
}

function parsedOrThrow<S extends z.ZodTypeAny>(schema: S, body: unknown, what: string): z.infer<S> {
  const r = schema.safeParse(body);
  if (!r.success) {
    throw new ExpectedToolError("meta_ads_invalid_edit_body", `This ${what} cannot be made as specified: ${r.error.issues.map((i) => i.message).join(" | ")}`);
  }
  return r.data;
}

const targetingInput = z.object({
  age_min: z.number().int().optional(),
  age_max: z.number().int().optional(),
  genders: z.array(z.number().int()).optional().describe("1 = men, 2 = women; [1,2] for everyone."),
  flexible_spec: z
    .array(z.record(z.string(), z.unknown()))
    .optional()
    .describe("Interest groups, e.g. [{\"interests\":[{\"id\":\"6003...\",\"name\":\"Yoga\"}]}]. Ids only from search_interests."),
  custom_audiences: z.array(z.object({ id: z.string() })).optional(),
  excluded_custom_audiences: z.array(z.object({ id: z.string() })).optional(),
  publisher_platforms: z.array(z.string()).optional().describe("facebook, instagram, messenger, audience_network, threads."),
  facebook_positions: z.array(z.string()).optional(),
  instagram_positions: z.array(z.string()).optional(),
});

const adSetUpdateInput = z.object({
  ad_set_id: z.string().min(1).describe("Ids only from list_ad_sets this turn."),
  new_name: z.string().min(1).max(200).optional(),
  end_time: z.string().optional().describe("New end date and time, ISO 8601 with offset (e.g. 2026-11-30T23:59:00-0800). This is how a campaign gets an end date: set it on its ad sets."),
  bid_strategy: metaBidStrategySchema.optional().describe("Only when the campaign does NOT hold the budget."),
  bid_amount_usd: z.number().positive().optional().describe("Bid cap or cost goal, in the account's currency."),
  targeting: targetingInput.optional().describe("ONLY the targeting keys to change; every other key (including places) is kept. Places have their own picker."),
  name: z.string().optional().describe("The ad set's current name, for the card."),
  about: z.string().optional(),
  rationale: rationaleInput(),
});

export const metaProposeAdSetUpdateTool: ToolSpec = {
  name: "meta_ads_propose_ad_set_update",
  effect: "money",
  description:
    "Propose changing a Meta ad set's name, end date, bid strategy, bid amount or targeting (age, gender, interests, audiences, placements). Budget and on/off have their own tools. A card the founder, or cgo on Autopilot with an ad budget, approves.",
  input_schema: adSetUpdateInput,
  async execute(ctx, input) {
    const emit = await preflight(ctx);
    const a = adSetUpdateInput.parse(input);
    const live = await readOwnAdSet(ctx.tenant_id, a.ad_set_id);
    const currency = await getAdAccountCurrency(ctx.tenant_id);
    const { targeting, ...rest } = a;
    const body = parsedOrThrow(
      updateAdSetBodySchema,
      {
        ...rest,
        currency,
        name: a.name ?? live.name,
        ...(a.end_time !== undefined ? { expected_current_end_time: live.end_time ? normalizeMetaTime(live.end_time) : null } : {}),
        ...(a.bid_strategy !== undefined ? { expected_current_bid_strategy: live.bid_strategy ?? null } : {}),
        ...(a.bid_amount_usd !== undefined
          ? { expected_current_bid_amount_usd: live.bid_amount == null ? null : minorToMajor(live.bid_amount, currency) }
          : {}),
        ...(targeting !== undefined
          ? { targeting_patch: targeting, expected_targeting_fingerprint: targetingFingerprint(live.targeting) }
          : {}),
        ...originOf(ctx),
      },
      "ad set change",
    );
    const decision_id = await emit("meta_ads.update_ad_set", body);
    return { decision_id, decision_class: "meta_ads.update_ad_set", notice: "Sent to approvals." };
  },
};

const adUpdateInput = z.object({
  ad_id: z.string().min(1).describe("Ids only from list_ads this turn."),
  new_name: z.string().min(1).max(200).optional(),
  creative_id: z.string().optional().describe("Swap the ad onto another creative already in this ad account."),
  status: z.enum(["ACTIVE", "PAUSED"]).optional().describe("Switch this one ad on or off; the ad set keeps running."),
  name: z.string().optional().describe("The ad's current name, for the card."),
  about: z.string().optional(),
  rationale: rationaleInput(),
});

export const metaProposeAdUpdateTool: ToolSpec = {
  name: "meta_ads_propose_ad_update",
  effect: "money",
  description:
    "Propose renaming one Meta ad, swapping it onto another creative, or switching that one ad on or off. A card the founder approves (cgo on Autopilot may approve a rename or a creative swap).",
  input_schema: adUpdateInput,
  async execute(ctx, input) {
    const emit = await preflight(ctx);
    const a = adUpdateInput.parse(input);
    let expected_current_creative_id: string | null | undefined;
    let liveName: string | undefined;
    if (a.creative_id !== undefined || a.name === undefined) {
      const live = (await fbGet(ctx.tenant_id, a.ad_id, { fields: "name,creative{id}" })) as { name?: string; creative?: { id?: string } };
      liveName = live?.name;
      if (a.creative_id !== undefined) expected_current_creative_id = live?.creative?.id ?? null;
    }
    const body = parsedOrThrow(
      updateAdBodySchema,
      {
        ...a,
        name: a.name ?? liveName,
        ...(expected_current_creative_id !== undefined ? { expected_current_creative_id } : {}),
        ...originOf(ctx),
      },
      "ad change",
    );
    const decision_id = await emit("meta_ads.update_ad", body);
    return { decision_id, decision_class: "meta_ads.update_ad", notice: "Sent to approvals." };
  },
};
