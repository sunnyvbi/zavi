
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ search: vi.fn(), mutate: vi.fn() }));
vi.mock("../../_client", async (orig) => ({
  ...(await orig<typeof import("../../_client")>()),
  gadsSearch: h.search,
  gadsMutateOperations: h.mutate,
}));

import {
  geoFingerprint,
  geoShape,
  googleReplaceGeoTargets,
  readGoogleGeoTargets,
  replaceGeoTargetsBodySchema,
  shapeReplaceGeoOperations,
  type GoogleGeoTargets,
} from "../replace_geo_targets";

const T = "11111111-1111-4111-8111-111111111111";
const CAMPAIGN = { campaign_id: "555", campaign_resource: "customers/1/campaigns/555", channel_type: "SEARCH" };
const crit = (rn: string, id: number, negative = false) => ({ campaignCriterion: { resourceName: rn, negative, location: { geoTargetConstant: `geoTargetConstants/${id}` } } });

function body(over: Record<string, unknown> = {}) {
  return replaceGeoTargetsBodySchema.parse({
    campaign_id: "555",
    level: "campaign",
    scope: "campaign",
    location_ids: [1014221, 1014044],
    before_names: ["United States"],
    place_names: ["San Francisco, CA", "Oakland, CA"],
    expected_fingerprint: "0".repeat(64),
    rationale: "founder pick",
    origin: "user_initiated_ledger",
    ...over,
  });
}

beforeEach(() => {
  h.search.mockReset();
  h.mutate.mockReset();
  h.mutate.mockResolvedValue([]);
});

describe("reading the live places", () => {
  it("campaign level: positive LOCATION criteria only (negatives are kept out of the replace)", async () => {
    h.search.mockResolvedValueOnce([crit("c/1", 2840), crit("c/2", 1014221, true)]);
    const t = await readGoogleGeoTargets(T, CAMPAIGN, "campaign");
    expect(t.owners).toEqual([{ resource: CAMPAIGN.campaign_resource, criteria: [{ resource_name: "c/1", geo_id: 2840 }] }]);
    expect(h.search.mock.calls[0][1]).toContain("campaign_criterion.type = 'LOCATION'");
  });

  it("ad group level: every live ad group, mixed when they disagree", async () => {
    h.search
      .mockResolvedValueOnce([{ adGroup: { resourceName: "ag/1" } }, { adGroup: { resourceName: "ag/2" } }])
      .mockResolvedValueOnce([
        { adGroup: { resourceName: "ag/1" }, adGroupCriterion: { resourceName: "agc/1", location: { geoTargetConstant: "geoTargetConstants/2840" } } },
        { adGroup: { resourceName: "ag/2" }, adGroupCriterion: { resourceName: "agc/2", location: { geoTargetConstant: "geoTargetConstants/2124" } } },
      ]);
    const t = await readGoogleGeoTargets(T, CAMPAIGN, "ad_group");
    expect(t.owners.map((o) => o.resource)).toEqual(["ag/1", "ag/2"]);
    expect(geoShape(t)).toBe("mixed");
  });
});

describe("the pure halves", () => {
  const live: GoogleGeoTargets = { level: "campaign", owners: [{ resource: "camp", criteria: [{ resource_name: "c/1", geo_id: 2840 }] }] };

  it("one atomic list: remove the live positives, then create the picks", () => {
    expect(shapeReplaceGeoOperations(live, [1014221, 1014221, 1014044])).toEqual([
      { service: "campaignCriteria", remove: "c/1" },
      { service: "campaignCriteria", create: { campaign: "camp", location: { geoTargetConstant: "geoTargetConstants/1014221" } } },
      { service: "campaignCriteria", create: { campaign: "camp", location: { geoTargetConstant: "geoTargetConstants/1014044" } } },
    ]);
  });

  it("Demand Gen: the picks go on every ad group", () => {
    const ag: GoogleGeoTargets = { level: "ad_group", owners: [{ resource: "ag/1", criteria: [] }, { resource: "ag/2", criteria: [] }] };
    const ops = shapeReplaceGeoOperations(ag, [2840]);
    expect(ops.map((o) => ("create" in o ? o.create.adGroup : null))).toEqual(["ag/1", "ag/2"]);
  });

  it("the fingerprint ignores order and changes with any id", () => {
    const a: GoogleGeoTargets = { level: "campaign", owners: [{ resource: "camp", criteria: [{ resource_name: "x", geo_id: 1 }, { resource_name: "y", geo_id: 2 }] }] };
    const b: GoogleGeoTargets = { level: "campaign", owners: [{ resource: "camp", criteria: [{ resource_name: "y", geo_id: 2 }, { resource_name: "x", geo_id: 1 }] }] };
    const c: GoogleGeoTargets = { level: "campaign", owners: [{ resource: "camp", criteria: [{ resource_name: "x", geo_id: 1 }] }] };
    expect(geoFingerprint(a)).toBe(geoFingerprint(b));
    expect(geoFingerprint(a)).not.toBe(geoFingerprint(c));
  });

  it("the body caps places at 50 and demands the founder origin", () => {
    expect(() => body({ location_ids: Array.from({ length: 51 }, (_, i) => i + 1) })).toThrow();
    expect(() => body({ origin: "agent" })).toThrow();
    expect(() => body({ location_ids: [] })).toThrow();
  });
});

describe("the write", () => {
  const liveRows = [crit("c/1", 2840)];
  const fp = geoFingerprint({ level: "campaign", owners: [{ resource: CAMPAIGN.campaign_resource, criteria: [{ resource_name: "c/1", geo_id: 2840 }] }] });

  it("replaces and reads back", async () => {
    h.search.mockResolvedValueOnce(liveRows).mockResolvedValueOnce([crit("c/9", 1014221), crit("c/8", 1014044)]);
    const r = await googleReplaceGeoTargets(T, CAMPAIGN, body({ expected_fingerprint: fp }));
    expect(h.mutate).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ location_ids: [1014044, 1014221], verified: true });
  });

  it("a stale fingerprint changes nothing", async () => {
    h.search.mockResolvedValueOnce([crit("c/1", 2124)]);
    await expect(googleReplaceGeoTargets(T, CAMPAIGN, body({ expected_fingerprint: fp }))).rejects.toMatchObject({ code: "google_ads_geo_stale" });
    expect(h.mutate).not.toHaveBeenCalled();
  });

  it("an unsupported campaign type (Local Services, Smart...) changes nothing", async () => {
    await expect(googleReplaceGeoTargets(T, { ...CAMPAIGN, channel_type: "LOCAL_SERVICES" }, body({ expected_fingerprint: fp }))).rejects.toMatchObject({
      code: "google_ads_geo_unsupported_campaign",
    });
    expect(h.search).not.toHaveBeenCalled();
  });

  it("mixed Demand Gen ad groups need scope all_ad_groups", async () => {
    const dg = { ...CAMPAIGN, channel_type: "DEMAND_GEN" };
    const groups = [{ adGroup: { resourceName: "ag/1" } }, { adGroup: { resourceName: "ag/2" } }];
    const rows = [
      { adGroup: { resourceName: "ag/1" }, adGroupCriterion: { resourceName: "agc/1", location: { geoTargetConstant: "geoTargetConstants/2840" } } },
      { adGroup: { resourceName: "ag/2" }, adGroupCriterion: { resourceName: "agc/2", location: { geoTargetConstant: "geoTargetConstants/2124" } } },
    ];
    const t: GoogleGeoTargets = {
      level: "ad_group",
      owners: [
        { resource: "ag/1", criteria: [{ resource_name: "agc/1", geo_id: 2840 }] },
        { resource: "ag/2", criteria: [{ resource_name: "agc/2", geo_id: 2124 }] },
      ],
    };
    h.search.mockResolvedValueOnce(groups).mockResolvedValueOnce(rows);
    await expect(googleReplaceGeoTargets(T, dg, body({ level: "ad_group", scope: "campaign", expected_fingerprint: geoFingerprint(t) }))).rejects.toMatchObject({
      code: "google_ads_geo_mixed",
    });
    expect(h.mutate).not.toHaveBeenCalled();
  });
});
