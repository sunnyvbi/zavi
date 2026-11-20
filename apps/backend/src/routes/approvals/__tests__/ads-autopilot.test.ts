import { describe, it, expect } from "vitest";
import {
  adsAutopilotBodySchema,
  mapAdsAutopilotResult,
} from "../ads-autopilot";

describe("adsAutopilotBodySchema", () => {
  it("accepts a valid enable body", () => {
    const r = adsAutopilotBodySchema.safeParse({
      platform: "meta_ads",
      enabled: true,
      max_daily_budget_usd: 50,
    });
    expect(r.success).toBe(true);
  });

  it("accepts google_ads platform", () => {
    expect(
      adsAutopilotBodySchema.safeParse({
        platform: "google_ads",
        enabled: true,
        max_daily_budget_usd: 100,
      }).success,
    ).toBe(true);
  });

  it("accepts a disable body with no budget", () => {
    expect(
      adsAutopilotBodySchema.safeParse({ platform: "meta_ads", enabled: false }).success,
    ).toBe(true);
  });

  it("rejects an unknown platform (never a generic class)", () => {
    expect(
      adsAutopilotBodySchema.safeParse({
        platform: "stripe",
        enabled: true,
        max_daily_budget_usd: 50,
      }).success,
    ).toBe(false);
  });

  it("rejects a non-positive budget", () => {
    expect(
      adsAutopilotBodySchema.safeParse({
        platform: "meta_ads",
        enabled: true,
        max_daily_budget_usd: 0,
      }).success,
    ).toBe(false);
    expect(
      adsAutopilotBodySchema.safeParse({
        platform: "meta_ads",
        enabled: true,
        max_daily_budget_usd: -10,
      }).success,
    ).toBe(false);
  });
});

describe("mapAdsAutopilotResult", () => {
  it("ok → 200", () => {
    expect(mapAdsAutopilotResult({ ok: true })).toEqual({
      status: 200,
      body: { ok: true },
    });
  });

  it("not_owner → 403", () => {
    const m = mapAdsAutopilotResult({ ok: false, reason: "not_owner" });
    expect(m.status).toBe(403);
    expect((m.body as { error: { code: string } }).error.code).toBe("not_owner");
  });

  it("over_self_serve_max → 422 with the max in the error", () => {
    const m = mapAdsAutopilotResult({ ok: false, reason: "over_self_serve_max", max: 500 });
    expect(m.status).toBe(422);
    const err = (m.body as { error: { code: string; max: number; message: string } }).error;
    expect(err.code).toBe("over_self_serve_max");
    expect(err.max).toBe(500);
    expect(err.message).toContain("$500");
  });

  it("bad_platform / bad_budget → 400", () => {
    expect(mapAdsAutopilotResult({ ok: false, reason: "bad_platform" }).status).toBe(400);
    expect(mapAdsAutopilotResult({ ok: false, reason: "bad_budget" }).status).toBe(400);
  });

  it("unknown reason → 500", () => {
    expect(mapAdsAutopilotResult({ ok: false, reason: "weird" }).status).toBe(500);
    expect(mapAdsAutopilotResult({}).status).toBe(500);
  });
});
