
import { describe, it, expect } from "vitest";
import {
  checkPromotedObjectForGoal,
  checkTargetingInterestIds,
  assertTargetingInterestIds,
  promotedObjectSchema,
} from "../_targeting-validate";
import { shapeCreateAdSetRequest } from "../_request-shapers";
import { createAdSetBodySchema } from "../_decision-bodies";

const VALID_PO = { pixel_id: "1234567890", custom_event_type: "COMPLETE_REGISTRATION" };

const REAL_FAILED_TARGETING = {
  age_max: 55,
  age_min: 25,
  flexible_spec: [
    {
      interests: [
        { name: "Turo" },
        { name: "Car sharing" },
        { name: "Car rental" },
        { name: "Peer-to-peer lending" },
      ],
    },
  ],
  geo_locations: { regions: [{ key: "3847", name: "California" }] },
};

describe("checkPromotedObjectForGoal", () => {
  it("REQUIRES promoted_object for OFFSITE_CONVERSIONS", () => {
    expect(checkPromotedObjectForGoal("OFFSITE_CONVERSIONS", undefined)).toMatch(
      /requires promoted_object/,
    );
  });

  it("requires pixel_id AND custom_event_type, not just the object", () => {
    expect(checkPromotedObjectForGoal("OFFSITE_CONVERSIONS", { pixel_id: "123" })).toMatch(
      /custom_event_type/,
    );
    expect(
      checkPromotedObjectForGoal("OFFSITE_CONVERSIONS", { custom_event_type: "LEAD" }),
    ).toMatch(/pixel_id/);
  });

  it("accepts a complete promoted_object", () => {
    expect(checkPromotedObjectForGoal("OFFSITE_CONVERSIONS", VALID_PO)).toBeNull();
  });

  it("does NOT require promoted_object for non-conversion goals", () => {
    expect(checkPromotedObjectForGoal("LINK_CLICKS", undefined)).toBeNull();
    expect(checkPromotedObjectForGoal("IMPRESSIONS", undefined)).toBeNull();
  });

  it("rejects a non-numeric pixel_id (a name/placeholder must never reach the wire)", () => {
    expect(promotedObjectSchema.safeParse({ pixel_id: "my-pixel" }).success).toBe(false);
    expect(promotedObjectSchema.safeParse({ pixel_id: "1234567890" }).success).toBe(true);
  });
});

describe("checkTargetingInterestIds", () => {
  it("REJECTS the exact targeting that failed in prod (name-only interests)", () => {
    const err = checkTargetingInterestIds(REAL_FAILED_TARGETING);
    expect(err).toBeTruthy();
    expect(err).toContain("Turo");
    expect(err).toContain("Car sharing");
    expect(err).toContain("meta_ads_search_interests");
  });

  it("accepts interests carrying a numeric id (string or number)", () => {
    expect(
      checkTargetingInterestIds({ interests: [{ id: "6003107902433", name: "Turo" }] }),
    ).toBeNull();
    expect(checkTargetingInterestIds({ interests: [{ id: 6003107902433, name: "x" }] })).toBeNull();
  });

  it("catches name-only interests nested in flexible_spec AND exclusions", () => {
    expect(checkTargetingInterestIds({ flexible_spec: [{ interests: [{ name: "x" }] }] })).toBeTruthy();
    expect(checkTargetingInterestIds({ exclusions: { interests: [{ name: "x" }] } })).toBeTruthy();
  });

  it("is a no-op for targeting with no interests at all (geo-only is valid)", () => {
    expect(checkTargetingInterestIds({ geo_locations: { countries: ["US"] } })).toBeNull();
    expect(checkTargetingInterestIds({})).toBeNull();
    expect(checkTargetingInterestIds(null)).toBeNull();
  });

  it("rejects a non-numeric id string (an invented id is not a real id)", () => {
    expect(checkTargetingInterestIds({ interests: [{ id: "turo", name: "Turo" }] })).toBeTruthy();
  });

  it("assert* throws ExpectedToolError with an actionable code", () => {
    expect(() => assertTargetingInterestIds(REAL_FAILED_TARGETING)).toThrowError(
      /numeric Meta interest id/,
    );
  });
});

describe("createAdSetBodySchema — refuses at PROPOSE time, before the operator's phone", () => {
  const BASE = {
    campaign_id: "120252797821770059",
    name: "Turo Host Conquest — Fee Comparison",
    daily_budget_usd: 20,
    optimization_goal: "OFFSITE_CONVERSIONS",
    billing_event: "IMPRESSIONS",
    rationale: "r",
  };

  it("REJECTS the real prod body (no promoted_object + name-only interests)", () => {
    const r = createAdSetBodySchema.safeParse({ ...BASE, targeting: REAL_FAILED_TARGETING });
    expect(r.success).toBe(false);
    const paths = r.success ? [] : r.error.issues.map((i) => i.path.join("."));
    expect(paths).toContain("promoted_object");
    expect(paths).toContain("targeting");
  });

  it("ACCEPTS a fully-grounded body", () => {
    const r = createAdSetBodySchema.safeParse({
      ...BASE,
      promoted_object: VALID_PO,
      targeting: { flexible_spec: [{ interests: [{ id: "6003107902433", name: "Turo" }] }] },
    });
    expect(r.success).toBe(true);
  });

  it("keeps promoted_object through the parse (it must survive reconstruct's whitelist)", () => {
    const r = createAdSetBodySchema.safeParse({
      ...BASE,
      promoted_object: VALID_PO,
      targeting: {},
    });
    expect(r.success && r.data.promoted_object).toEqual(VALID_PO);
  });
});

describe("shapeCreateAdSetRequest — the wire shape", () => {
  const BASE = {
    campaign_id: "c1",
    name: "n",
    daily_budget_usd: 20,
    billing_event: "IMPRESSIONS",
    targeting: { geo_locations: { countries: ["US"] } },
  };

  it("JSON-encodes promoted_object onto the POST params", () => {
    const r = shapeCreateAdSetRequest(
      { ...BASE, optimization_goal: "OFFSITE_CONVERSIONS", promoted_object: VALID_PO },
      "USD",
      "act_1",
    );
    expect(r.params.promoted_object).toBe(JSON.stringify(VALID_PO));
  });

  it("OMITS the promoted_object key entirely when absent (never sends 'undefined')", () => {
    const r = shapeCreateAdSetRequest(
      { ...BASE, optimization_goal: "LINK_CLICKS" },
      "USD",
      "act_1",
    );
    expect("promoted_object" in r.params).toBe(false);
  });

  it("REFUSES a conversion create with no promoted_object (defense in depth vs a direct insert)", () => {
    expect(() =>
      shapeCreateAdSetRequest({ ...BASE, optimization_goal: "OFFSITE_CONVERSIONS" }, "USD", "act_1"),
    ).toThrowError(/requires promoted_object/);
  });

  it("REFUSES name-only interests at the wire even if the body somehow got here", () => {
    expect(() =>
      shapeCreateAdSetRequest(
        {
          ...BASE,
          optimization_goal: "LINK_CLICKS",
          targeting: { interests: [{ name: "Turo" }] },
        },
        "USD",
        "act_1",
      ),
    ).toThrowError(/numeric Meta interest id/);
  });

  it("still creates PAUSED — the no-spend-on-create invariant is untouched", () => {
    const r = shapeCreateAdSetRequest(
      { ...BASE, optimization_goal: "OFFSITE_CONVERSIONS", promoted_object: VALID_PO },
      "USD",
      "act_1",
    );
    expect(r.params.status).toBe("PAUSED");
  });
});
