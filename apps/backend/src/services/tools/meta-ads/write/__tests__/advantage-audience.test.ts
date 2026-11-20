import { describe, it, expect } from "vitest";
import { withAudienceMode, isBroadTargeting, checkTargetingPlacements } from "../_targeting-validate";
import { shapeCreateAdSetRequest } from "../_request-shapers";
import { shapeLaunchAdSetRequest } from "../_launch-shapers";
import { adSetTargetingPatchSchema, createAdSetBodySchema } from "../_decision-bodies";
import { ExpectedToolError } from "@/services/tools/types";

const US = { geo_locations: { countries: ["US"] } };
const sent = (t: Record<string, unknown>) =>
  JSON.parse(
    shapeCreateAdSetRequest(
      { campaign_id: "c1", name: "n", daily_budget_usd: 20, optimization_goal: "LINK_CLICKS", billing_event: "IMPRESSIONS", targeting: t },
      "USD",
      "act_1",
    ).params.targeting as string,
  );

describe("advantage audience: server-set flag on create", () => {
  it("retargeting a website-visitor audience stays on that audience (flag 0, expansion off)", () => {
    expect(sent({ ...US, custom_audiences: [{ id: "120240072436710168" }] })).toEqual({
      ...US,
      custom_audiences: [{ id: "120240072436710168" }],
      targeting_automation: { advantage_audience: 0 },
      targeting_relaxation_types: { custom_audience: 0, lookalike: 0 },
    });
  });

  it("the 10-15 shape (geo, ages 21-65) keeps Meta's own default of 1", () => {
    expect(sent({ ...US, age_min: 21, age_max: 65 }).targeting_automation).toEqual({ advantage_audience: 1 });
  });

  it("replaces an agent-supplied 1 on a retargeting ad set", () => {
    const t = sent({ ...US, custom_audiences: [{ id: "1" }], targeting_automation: { advantage_audience: 1 }, targeting_relaxation_types: { custom_audience: 1 } });
    expect(t.targeting_automation).toEqual({ advantage_audience: 0 });
    expect(t.targeting_relaxation_types).toEqual({ custom_audience: 0, lookalike: 0 });
  });

  it.each([
    ["interests", { ...US, flexible_spec: [{ interests: [{ id: "6003", name: "Road trips" }] }] }],
    ["one gender", { ...US, genders: [2] }],
    ["minimum age over 25", { ...US, age_min: 30 }],
    ["maximum age under 65", { ...US, age_max: 54 }],
    ["an unknown key", { ...US, behaviors: [{ id: "1" }] }],
  ])("%s → 0", (_label, t) => {
    expect(sent(t).targeting_automation).toEqual({ advantage_audience: 0 });
    expect(sent(t).targeting_relaxation_types).toBeUndefined();
  });

  it.each([
    ["geo only", US],
    ["both genders", { ...US, genders: [1, 2] }],
    ["exclusions and placements", { ...US, excluded_custom_audiences: [{ id: "9" }], publisher_platforms: ["instagram"] }],
    ["empty custom audience list", { ...US, custom_audiences: [] }],
  ])("%s → 1", (_label, t) => {
    expect(isBroadTargeting(t)).toBe(true);
    expect(withAudienceMode(t).targeting_automation).toEqual({ advantage_audience: 1 });
  });

  it("the one-card launch shaper sends the same flag", () => {
    const r = shapeLaunchAdSetRequest(
      { ad_account_id: "act_1", campaign_id: "120240000000001", name: "n", optimization_goal: "LINK_CLICKS", billing_event: "IMPRESSIONS", targeting: { ...US, custom_audiences: [{ id: "5" }] }, bid_strategy: "LOWEST_COST_WITHOUT_CAP" },
      "USD",
    );
    expect(JSON.parse(r.params.targeting as string).targeting_automation).toEqual({ advantage_audience: 0 });
  });

  it("an audience inside a flexible_spec clause also gets expansion off", () => {
    const t = sent({ ...US, flexible_spec: [{ custom_audiences: [{ id: "3" }] }] });
    expect(t.targeting_automation).toEqual({ advantage_audience: 0 });
    expect(t.targeting_relaxation_types).toEqual({ custom_audience: 0, lookalike: 0 });
  });

  it("does not mutate the caller's targeting", () => {
    const t = { ...US, custom_audiences: [{ id: "1" }] };
    withAudienceMode(t);
    expect(t).toEqual({ ...US, custom_audiences: [{ id: "1" }] });
  });
});

describe("video_feeds placement (retired in v24)", () => {
  const vf = { ...US, facebook_positions: ["feed", "video_feeds"] };
  it("is refused by the check, the create shaper, the create body and the edit patch", () => {
    expect(checkTargetingPlacements(vf)).toMatch(/video_feeds/);
    expect(() => sent(vf)).toThrow(ExpectedToolError);
    expect(
      createAdSetBodySchema.safeParse({ campaign_id: "c1", name: "n", daily_budget_usd: 20, optimization_goal: "LINK_CLICKS", billing_event: "IMPRESSIONS", targeting: vf, rationale: "r" }).success,
    ).toBe(false);
    expect(adSetTargetingPatchSchema.safeParse({ facebook_positions: ["video_feeds"] }).success).toBe(false);
    expect(adSetTargetingPatchSchema.safeParse({ facebook_positions: ["feed"] }).success).toBe(true);
  });
});
