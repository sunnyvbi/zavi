
import { describe, it, expect, vi, beforeEach } from "vitest";

const g = vi.hoisted(() => ({ fbGet: vi.fn(), fbPost: vi.fn(), creds: vi.fn() }));
vi.mock("../../_client", () => ({
  fbGet: (...a: unknown[]) => g.fbGet(...a),
  fbPost: (...a: unknown[]) => g.fbPost(...a),
  metaAdsCreds: (...a: unknown[]) => g.creds(...a),
}));
vi.mock("../_flag-check", () => ({ isMetaAdsWriteEnabled: vi.fn(async () => true) }));
vi.mock("../cap-reader", () => {
  const m = { readTenantCapAndToday: vi.fn(async () => ({ cap: null, today_total_change_usd: 0, currency: "USD", units_per_usd: 1 })) };
  return { ...m, readTenantCapRowAndToday: m.readTenantCapAndToday };
});

import {
  metaCreateCustomConversion,
  metaCreateLookalikeAudience,
  shapeCustomConversionRequest,
  shapeLookalikeRequest,
} from "../measurement_writes";
import { createCustomConversionBodySchema, createLookalikeAudienceBodySchema } from "../_decision-bodies";
import { metaProposeCustomAudienceTool } from "../propose_launch";
import { metaProposeCustomConversionTool } from "../propose_measurement";
import { metaListMeasurementTool } from "../../measurement_reads";
import type { ToolContext } from "@/services/tools/types";

beforeEach(() => {
  vi.clearAllMocks();
  g.creds.mockResolvedValue({ ad_account_id: "act_555", access_token: "t" });
  g.fbPost.mockResolvedValue({ id: "new1" });
});

const ctx = () => {
  const emit = vi.fn(async () => "d-1");
  return { c: { tenant_id: "t1", log: () => {}, emit_decision: emit, run_trigger: "scheduled" } as ToolContext, emit };
};

describe("shapes", () => {
  it("a lookalike names its source, country and ratio", () => {
    expect(shapeLookalikeRequest({ ad_account_id: "act_555", name: "L", origin_audience_id: "238001", country: "US", ratio: 0.02 }).params).toEqual({
      name: "L",
      subtype: "LOOKALIKE",
      origin_audience_id: "238001",
      lookalike_spec: JSON.stringify({ ratio: 0.02, country: "US" }),
    });
  });

  it("a custom conversion narrows the pixel event with a URL rule", () => {
    const r = shapeCustomConversionRequest({ ad_account_id: "act_555", name: "C", pixel_id: "900001", custom_event_type: "PURCHASE", url_contains: "thank-you" });
    expect(r.path).toBe("act_555/customconversions");
    expect(JSON.parse(r.params.rule)).toEqual({ url: { i_contains: "thank-you" } });
  });

  it("a lookalike ratio stays within Meta's 1-10%", () => {
    expect(createLookalikeAudienceBodySchema.safeParse({ origin_audience_id: "238001", country: "us", ratio: 0.2 }).success).toBe(false);
    expect(createLookalikeAudienceBodySchema.parse({ origin_audience_id: "238001", country: "us", ratio: 0.05 }).country).toBe("US");
  });
});

describe("executors", () => {
  it("a lookalike of another account's audience is refused before anything is sent", async () => {
    g.fbGet.mockResolvedValueOnce({ id: "238001", account_id: "999" });
    const body = createLookalikeAudienceBodySchema.parse({ origin_audience_id: "238001", country: "US", ratio: 0.01 });
    await expect(metaCreateLookalikeAudience("t1", { ...body, tag: "zvabc1234567" })).rejects.toMatchObject({ code: "meta_ads_invalid_target" });
    expect(g.fbPost).not.toHaveBeenCalled();
  });

  it("a lookalike retry finds its audience by the tag", async () => {
    g.fbGet
      .mockResolvedValueOnce({ id: "238001", account_id: "555", name: "Buyers" })
      .mockResolvedValueOnce({ data: [{ id: "238099", name: "Zavi · Lookalike 1% US of Buyers · zvabc1234567" }] });
    const body = createLookalikeAudienceBodySchema.parse({ origin_audience_id: "238001", country: "US", ratio: 0.01 });
    expect(await metaCreateLookalikeAudience("t1", { ...body, tag: "zvabc1234567" })).toMatchObject({ id: "238099", reused: true });
  });

  it("a custom conversion on a pixel outside the account is refused", async () => {
    g.fbGet.mockResolvedValueOnce({ data: [{ id: "900001" }] });
    const body = createCustomConversionBodySchema.parse({ name: "Booked", pixel_id: "900002", custom_event_type: "SCHEDULE", url_contains: "booked" });
    await expect(metaCreateCustomConversion("t1", { ...body, tag: "zvabc1234567" })).rejects.toMatchObject({ code: "meta_ads_pixel_not_in_account" });
    expect(g.fbPost).not.toHaveBeenCalled();
  });

  it("a custom conversion is created with the tagged name", async () => {
    g.fbGet.mockResolvedValueOnce({ data: [{ id: "900001" }] }).mockResolvedValueOnce({ data: [] });
    const body = createCustomConversionBodySchema.parse({ name: "Booked", pixel_id: "900001", custom_event_type: "SCHEDULE", url_contains: "booked" });
    expect(await metaCreateCustomConversion("t1", { ...body, tag: "zvabc1234567" })).toEqual({ id: "new1", name: "Booked · zvabc1234567", reused: false });
  });
});

describe("tools", () => {
  it("the audience tool files a lookalike on its own class, and a website audience as before", async () => {
    const a = ctx();
    await metaProposeCustomAudienceTool.execute(a.c, { kind: "lookalike", origin_audience_id: "238001", country: "US", ratio: 0.01, rationale: "scale buyers" });
    expect(a.emit).toHaveBeenCalledWith("meta_ads.create_lookalike_audience", expect.objectContaining({ origin_audience_id: "238001", ratio: 0.01 }));
    const b = ctx();
    await metaProposeCustomAudienceTool.execute(b.c, { retention_days: 30, rationale: "retarget" });
    expect(b.emit).toHaveBeenCalledWith("meta_ads.create_custom_audience", expect.objectContaining({ kind: "website_visitors", retention_days: 30 }));
  });

  it("the custom conversion tool files its class", async () => {
    const a = ctx();
    await metaProposeCustomConversionTool.execute(a.c, { name: "Booked", pixel_id: "900001", custom_event_type: "SCHEDULE", url_contains: "booked", rationale: "optimise for bookings" });
    expect(a.emit).toHaveBeenCalledWith("meta_ads.create_custom_conversion", expect.objectContaining({ name: "Booked" }));
  });

  it("the read lists pixels from the tenant's own account", async () => {
    g.fbGet.mockResolvedValueOnce({ data: [{ id: "900001", name: "Site", last_fired_time: "2026-10-07T10:00:00+0000" }] });
    const r = await metaListMeasurementTool.execute(ctx().c, { kind: "pixels" });
    expect(g.fbGet.mock.calls[0][1]).toBe("act_555/adspixels");
    expect(r).toMatchObject({ kind: "pixels", truncated: false });
  });
});
