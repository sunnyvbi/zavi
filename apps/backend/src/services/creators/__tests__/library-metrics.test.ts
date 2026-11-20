import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeFakeDb, type FakeDb } from "./fake-supabase";

const m = vi.hoisted(() => ({
  serviceClient: vi.fn(),
  execute: vi.fn(),
  logEvent: vi.fn(async () => {}),
}));

vi.mock("@/services/supabase", () => ({ serviceClient: m.serviceClient }));
vi.mock("@/../workers/client", () => ({
  inngest: { createFunction: () => ({ id: "stub" }), send: vi.fn(async () => ({ ids: ["e1"] })) },
}));
vi.mock("@/services/tools/meta-ads/list_ads", () => ({
  metaListAdsTool: { name: "meta_ads_list_ads", execute: m.execute },
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: m.logEvent }));

import { ExpectedToolError } from "@/services/tools/types";
import {
  isDue,
  isSettled,
  projectMetrics,
  readbackAssetMetrics,
  type LibraryMetricsRow,
} from "../library-metrics";
import { CREATOR_AD_METRICS_MIN_CONVERSIONS, creatorAdEvidence } from "@zavi/shared";

const TENANT = "11111111-1111-4111-8111-111111111111";
const ORDER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HOUR = 60 * 60 * 1000;

function row(over: Partial<LibraryMetricsRow> = {}): LibraryMetricsRow {
  return {
    id: "asset-1",
    tenant_id: TENANT,
    order_id: ORDER,
    meta_ad_id: "777",
    meta_ad_set_id: "888",
    meta_auto_paused_at: null,
    rights_start_at: "2026-06-01T00:00:00.000Z",
    rights_end_at: "2026-12-01T00:00:00.000Z",
    metrics_read_at: null,
    ...over,
  };
}

function adRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ad_id: "777",
    ad_name: "Zavi creator zavi-cr-abc",
    adset_id: "888",
    campaign_id: "999",
    spend_usd: 1234.5,
    impressions: 90000,
    clicks: 2200,
    ctr_percent: 2.44,
    cpc_usd: 0.56,
    reach: 61000,
    frequency: 1.47,
    conversions: 120,
    purchases: 90,
    purchase_value_usd: 7600,
    roas: 6.16,
    cpa_usd: 10.29,
    status: "ACTIVE",
    effective_status: "ACTIVE",
    ...over,
  };
}

function db(snapshotKind: string): FakeDb {
  const fake = makeFakeDb({
    creator_orders: [
      {
        id: ORDER,
        tenant_id: TENANT,
        package_snapshot: { kind: snapshotKind, ad_rights_days: 90 },
      },
    ],
    creator_library_assets: [{ id: "asset-1", tenant_id: TENANT }],
  });
  m.serviceClient.mockReturnValue(fake.client);
  return fake;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.execute.mockResolvedValue({ ads: [adRow()] });
});

describe("what we are willing to store", () => {
  it("keeps ONLY absolute counts and totals — no roas, no cpa, no ctr", () => {
    const projected = projectMetrics(adRow());
    expect(projected).toEqual({
      spend_usd: 1234.5,
      impressions: 90000,
      clicks: 2200,
      reach: 61000,
      conversions: 120,
      purchases: 90,
      purchase_value_usd: 7600,
    });
    for (const ratio of ["roas", "cpa_usd", "ctr_percent", "frequency"]) {
      expect(Object.keys(projected)).not.toContain(ratio);
    }
  });

  it("treats a field Meta did not return as 0, not as a hole", () => {
    expect(projectMetrics({ ad_id: "777" }).impressions).toBe(0);
    expect(projectMetrics({ conversions: "not a number" }).conversions).toBe(0);
  });
});

describe("readbackAssetMetrics", () => {
  it("writes this ad's own numbers onto the row", async () => {
    const fake = db("ugc_video");
    const now = new Date("2026-09-13T12:00:00.000Z");

    const out = await readbackAssetMetrics(row(), { now });

    expect(out.outcome).toBe("written");
    expect(fake.updated.at(-1)?.values).toMatchObject({
      metrics: { conversions: 120, spend_usd: 1234.5 },
      metrics_read_at: now.toISOString(),
    });
  });

  it("scopes the read by the stored ad set, over the ad's whole life", async () => {
    db("ugc_video");
    await readbackAssetMetrics(row(), { now: new Date("2026-09-13T12:00:00.000Z") });

    expect(m.execute).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: TENANT }),
      expect.objectContaining({
        adset_id: "888",
        time_range: { since: "2026-06-01", until: "2026-09-13" },
      }),
    );
  });

  it("skips an asset with no ad set instead of reading the whole account", async () => {
    db("ugc_video");
    const out = await readbackAssetMetrics(row({ meta_ad_set_id: null }));
    expect(out.outcome).toBe("no_ad_set");
    expect(m.execute).not.toHaveBeenCalled();
  });

  it("leaves the last true snapshot standing when the ad is no longer in the set", async () => {
    const fake = db("ugc_video");
    m.execute.mockResolvedValue({ ads: [adRow({ ad_id: "other" })] });

    const out = await readbackAssetMetrics(row());

    expect(out.outcome).toBe("ad_not_in_set");
    expect(fake.updated).toEqual([]);
  });

  it("settles a vanished ad once its attribution window has closed", async () => {
    const fake = db("ugc_video");
    m.execute.mockResolvedValue({ ads: [adRow({ ad_id: "other" })] });

    const pausedLongAgo = row({
      meta_auto_paused_at: "2026-09-01T00:00:00.000Z",
      metrics_read_at: "2026-09-01T01:00:00.000Z",
    });
    const out = await readbackAssetMetrics(pausedLongAgo, {
      now: new Date("2026-09-30T00:00:00.000Z"),
    });

    expect(out.outcome).toBe("ad_not_in_set");
    expect(fake.updated).toHaveLength(1);
    expect(fake.updated[0].table).toBe("creator_library_assets");
    expect(fake.updated[0].values).toHaveProperty("metrics_read_at");
    expect(fake.updated[0].values).not.toHaveProperty("metrics");
  });

  it("defers instead of writing zeroes when Meta cannot be reached", async () => {
    const fake = db("ugc_video");
    m.execute.mockRejectedValue(new ExpectedToolError("meta_ads_token_expired", "expired"));

    const out = await readbackAssetMetrics(row());

    expect(out.outcome).toBe("deferred");
    expect(fake.updated).toEqual([]);
  });
});

describe("when a row is worth a read", () => {
  const READ = "2026-09-13T00:00:00.000Z";
  const now = Date.parse(READ);

  it("reads a never-read row immediately", () => {
    expect(isDue(row(), 4 * HOUR, now)).toBe(true);
  });

  it("waits out the staleness window", () => {
    expect(isDue(row({ metrics_read_at: READ }), 4 * HOUR, now + HOUR)).toBe(false);
    expect(isDue(row({ metrics_read_at: READ }), 4 * HOUR, now + 5 * HOUR)).toBe(true);
  });

  it("settles a paused ad only once the attribution window has passed", () => {
    const justPaused = row({
      meta_auto_paused_at: READ,
      metrics_read_at: "2026-09-13T01:00:00.000Z",
    });
    expect(isSettled(justPaused)).toBe(false);
    expect(isDue(justPaused, 4 * HOUR, now + 5 * HOUR)).toBe(true);

    const windowPassed = row({
      meta_auto_paused_at: READ,
      metrics_read_at: "2026-09-21T01:00:00.000Z",
    });
    expect(isSettled(windowPassed)).toBe(true);
    expect(isDue(windowPassed, 4 * HOUR, now + 500 * HOUR)).toBe(false);

    const owed = row({ meta_auto_paused_at: READ, metrics_read_at: "2026-09-12T00:00:00.000Z" });
    expect(isSettled(owed)).toBe(false);
    expect(isDue(owed, 4 * HOUR, now + 5 * HOUR)).toBe(true);
  });
});

describe("the evidence bar is one number in one place", () => {
  it("is 50 conversions", () => {
    expect(CREATOR_AD_METRICS_MIN_CONVERSIONS).toBe(50);
  });

  it("stops showing a progress line once there is no progress left to make", () => {
    expect(creatorAdEvidence(17).progress_label).toBe("17 of 50 conversions");
    expect(creatorAdEvidence(49).progress_label).toBe("49 of 50 conversions");
    expect(creatorAdEvidence(50).progress_label).toBeNull();
    expect(creatorAdEvidence(624).progress_label).toBeNull();
    expect(creatorAdEvidence(624).conversions).toBe(624);
    expect(creatorAdEvidence(624).enough_evidence).toBe(true);
  });
});
