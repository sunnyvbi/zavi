
import { describe, it, expect } from "vitest";
import { ExpectedToolError } from "@/services/tools/types";
import {
  shapeUpdateAdSetBudgetRequest,
  shapeSetStatusRequest,
  shapeCreateAdSetRequest,
} from "../_request-shapers";

describe("shapeUpdateAdSetBudgetRequest", () => {
  it("targets the ad set and serialises the budget as minor-unit string", () => {
    const r = shapeUpdateAdSetBudgetRequest(
      { ad_set_id: "120201234567890", daily_budget_usd: 25 },
      "USD",
    );
    expect(r).toEqual({
      path: "120201234567890",
      params: { daily_budget: "2500" },
    });
  });

  it("rejects an empty ad_set_id", () => {
    expect(() =>
      shapeUpdateAdSetBudgetRequest(
        { ad_set_id: "", daily_budget_usd: 5 },
        "USD",
      ),
    ).toThrow(ExpectedToolError);
  });

  it("rejects a non-USD currency via the budget helper", () => {
    try {
      shapeUpdateAdSetBudgetRequest(
        { ad_set_id: "x", daily_budget_usd: 5 },
        "EUR",
      );
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ExpectedToolError).code).toBe("meta_ads_unsupported_currency");
    }
  });
});

describe("shapeSetStatusRequest", () => {
  it("flips an ad set to PAUSED", () => {
    const r = shapeSetStatusRequest({
      object_id: "120201234567890",
      level: "adset",
      status: "PAUSED",
    });
    expect(r).toEqual({
      path: "120201234567890",
      params: { status: "PAUSED" },
    });
  });

  it("flips a campaign to ACTIVE", () => {
    const r = shapeSetStatusRequest({
      object_id: "23842",
      level: "campaign",
      status: "ACTIVE",
    });
    expect(r).toEqual({
      path: "23842",
      params: { status: "ACTIVE" },
    });
  });

  it("rejects an unsupported status", () => {
    expect(() =>
      shapeSetStatusRequest({
        object_id: "x",
        level: "adset",
        // @ts-expect-error — runtime guard for callers that bypass TS
        status: "ARCHIVED",
      }),
    ).toThrow(ExpectedToolError);
  });

  it("rejects an unsupported level", () => {
    expect(() =>
      shapeSetStatusRequest({
        object_id: "x",
        // @ts-expect-error — runtime guard
        level: "creative",
        status: "PAUSED",
      }),
    ).toThrow(ExpectedToolError);
  });

  it("shapes an ad-level pause", () => {
    expect(shapeSetStatusRequest({ object_id: "120", level: "ad", status: "PAUSED" })).toEqual({
      path: "120",
      params: { status: "PAUSED" },
    });
  });

  it("rejects an empty object_id", () => {
    expect(() =>
      shapeSetStatusRequest({ object_id: "", level: "adset", status: "PAUSED" }),
    ).toThrow(ExpectedToolError);
  });
});

describe("shapeCreateAdSetRequest", () => {
  const valid = {
    campaign_id: "23842",
    name: "Bay Area — vans — wk20",
    daily_budget_usd: 30,
    optimization_goal: "OFFSITE_CONVERSIONS",
    promoted_object: { pixel_id: "1234567890", custom_event_type: "COMPLETE_REGISTRATION" },
    billing_event: "IMPRESSIONS",
    targeting: { geo_locations: { countries: ["US"] } },
  } as const;

  it("GS09: a city or region with no Meta key never reaches the wire; keyed places do", () => {
    const named = { ...valid, targeting: { geo_locations: { cities: [{ name: "Austin" }] } } };
    expect(() => shapeCreateAdSetRequest(named, "USD", "act_1")).toThrow(expect.objectContaining({ code: "meta_ads_invalid_location" }));
    const keyed = { ...valid, targeting: { geo_locations: { regions: [{ key: "3886" }], cities: [{ key: 2421836 }] } } };
    expect(JSON.parse(shapeCreateAdSetRequest(keyed, "USD", "act_1").params.targeting)).toEqual({ ...keyed.targeting, targeting_automation: { advantage_audience: 1 } });
    const badCountry = { ...valid, targeting: { geo_locations: { countries: ["United States"] } } };
    expect(() => shapeCreateAdSetRequest(badCountry, "USD", "act_1")).toThrow(/United States/);
  });

  it("targets the ad account adsets endpoint", () => {
    const r = shapeCreateAdSetRequest(valid, "USD", "act_1500492811682727");
    expect(r.path).toBe("act_1500492811682727/adsets");
  });

  it("converts budget + passes through campaign/name/optimization fields", () => {
    const r = shapeCreateAdSetRequest(valid, "USD", "act_1");
    expect(r.params.campaign_id).toBe("23842");
    expect(r.params.name).toBe("Bay Area — vans — wk20");
    expect(r.params.daily_budget).toBe("3000");
    expect(r.params.optimization_goal).toBe("OFFSITE_CONVERSIONS");
    expect(r.params.billing_event).toBe("IMPRESSIONS");
  });

  it("defaults status to PAUSED so a created ad set never auto-spends", () => {
    const r = shapeCreateAdSetRequest(valid, "USD", "act_1");
    expect(r.params.status).toBe("PAUSED");
  });

  it("respects an explicit status when caller already gates it", () => {
    const r = shapeCreateAdSetRequest({ ...valid, status: "ACTIVE" }, "USD", "act_1");
    expect(r.params.status).toBe("ACTIVE");
  });

  it("JSON-encodes targeting (Graph requires a string)", () => {
    const r = shapeCreateAdSetRequest(valid, "USD", "act_1");
    expect(typeof r.params.targeting).toBe("string");
    expect(JSON.parse(r.params.targeting as string)).toEqual({
      geo_locations: { countries: ["US"] },
      targeting_automation: { advantage_audience: 1 },
    });
  });

  it("rejects an empty name", () => {
    expect(() =>
      shapeCreateAdSetRequest({ ...valid, name: "  " }, "USD", "act_1"),
    ).toThrow(ExpectedToolError);
  });

  it("rejects an empty campaign_id", () => {
    expect(() =>
      shapeCreateAdSetRequest({ ...valid, campaign_id: "" }, "USD", "act_1"),
    ).toThrow(ExpectedToolError);
  });
});
