
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ budget: true, country: { code: "GB", name: "United Kingdom" } as { code: string; name: string } | null }));
vi.mock("@/services/tools/meta-ads/write/_ad-set-bid", () => ({ resolveCreateAdSetBid: async (_t: string, d: unknown) => d }));
vi.mock("@/services/tools/meta-ads/write/_flag-check", () => ({ isMetaAdsWriteEnabled: vi.fn(async () => true) }));
vi.mock("@/services/tools/meta-ads/write/cap-reader", () => ({ readTenantCapAndToday: vi.fn(async () => ({ cap: null, today_total_change_usd: 0 })) }));
vi.mock("@/services/growth/cgo-ads", () => ({ cgoAdBudget: vi.fn(async () => (h.budget ? { id: "b1" } : null)) }));
vi.mock("@/services/ad-locations/country", async (orig) => ({
  ...(await orig<typeof import("@/services/ad-locations/country")>()),
  businessCountry: vi.fn(async () => h.country),
}));

import { metaProposeNewAdSetTool } from "@/services/tools/meta-ads/write/propose_new_ad_set";
import { evaluateUnattended } from "@/services/growth/unattended-policy";
import type { ToolContext } from "@/services/tools/types";

const input = {
  campaign_id: "camp-123",
  name: "Prospecting",
  daily_budget_usd: 30,
  optimization_goal: "LINK_CLICKS",
  billing_event: "IMPRESSIONS",
  targeting: { age_min: 25 } as Record<string, unknown>,
  rationale: "launch",
};

function run(over: Partial<ToolContext> = {}, args: Record<string, unknown> = {}) {
  const emit = vi.fn(async (_c: string, _b: unknown) => "d-1");
  const ctx: ToolContext = { tenant_id: "t-1", log: () => {}, emit_decision: emit, ...over };
  return metaProposeNewAdSetTool.execute(ctx, { ...input, ...args }).then(() => emit.mock.calls[0][1] as { targeting: Record<string, unknown> });
}

beforeEach(() => {
  h.budget = true;
  h.country = { code: "GB", name: "United Kingdom" };
});

describe("Meta: the CGO's new ad set starts across the business's country", () => {
  it("no places + Autopilot budget + a country on the record -> the whole country, other targeting kept", async () => {
    const body = await run();
    expect(body.targeting).toEqual({ age_min: 25, geo_locations: { countries: ["GB"] } });
  });

  it("no country on the record -> nothing invented (Meta then refuses a place-less ad set, the founder decides)", async () => {
    h.country = null;
    expect((await run()).targeting).toEqual({ age_min: 25 });
  });

  it("places the run chose are never replaced", async () => {
    const geo = { cities: [{ key: "2420379" }] };
    expect((await run({}, { targeting: { geo_locations: geo } })).targeting).toEqual({ geo_locations: geo });
  });

  it("a founder's own chat command is created as asked", async () => {
    expect((await run({ run_trigger: "chat" })).targeting).toEqual({ age_min: 25 });
  });

  it("without an Autopilot ad budget nothing is defaulted", async () => {
    h.budget = false;
    expect((await run()).targeting).toEqual({ age_min: 25 });
  });
});

describe("a Meta ad set with no places is the founder's call", () => {
  const cgo = (targeting: Record<string, unknown>) =>
    evaluateUnattended(
      {
        kind: "ad",
        exec_class: "meta_ads.create_ad_set",
        payload: { campaign_id: "c", name: "n", daily_budget_usd: 10, optimization_goal: "LINK_CLICKS", billing_event: "IMPRESSIONS", targeting, rationale: "r" },
        source: { table: "decisions", id: "d", run_id: null },
      },
      { refsResolved: true, openAdvice: "clear", goal: { present: false } },
    );
  it("no geo_locations (no country on the record) -> the CGO asks the founder", () => {
    expect(cgo({ age_min: 25 }).reasons).toContain("no_location_target");
    expect(cgo({ geo_locations: { location_types: ["home"] } }).reasons).toContain("no_location_target");
    expect(cgo({ geo_locations: { countries: [null], cities: [{}] } }).reasons).toContain("no_location_target");
  });
  it("a country or cities -> no location question", () => {
    expect(cgo({ geo_locations: { countries: ["GB"] } }).reasons).not.toContain("no_location_target");
    expect(cgo({ geo_locations: { cities: [{ key: "2420379" }] } }).reasons).not.toContain("no_location_target");
  });
});

describe("the founder's location change is never the CGO's to approve", () => {
  for (const exec_class of ["google_ads.replace_geo_targets_review", "meta_ads.replace_ad_set_geo_review"]) {
    it(`${exec_class} is never approved unattended`, () => {
      const v = evaluateUnattended(
        { kind: "ad", exec_class, payload: { origin: "user_initiated_ledger" }, source: { table: "decisions", id: "d", run_id: null } },
        { refsResolved: true, openAdvice: "clear", goal: { present: false } },
      );
      expect(v.verdict).not.toBe("allow");
      expect(v.reasons).toContain("review_class_never_unattended");
    });
  }
});
