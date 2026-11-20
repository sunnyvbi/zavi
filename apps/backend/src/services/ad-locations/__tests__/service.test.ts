
import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

type Row = Record<string, unknown>;
const h = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  scopes: [] as string[],
  upserts: [] as Array<{ table: string; row: Row }>,
  rpc: vi.fn(),
  decide: vi.fn(),
  campaign: { channel_type: "SEARCH", campaign_resource: "customers/1/campaigns/555" },
  googleTargets: null as unknown,
  googleNames: vi.fn(),
  readGooglePlaces: vi.fn(),
  resolvePlace: vi.fn(),
  metaTargeting: null as unknown,
  verifyMeta: vi.fn(),
  country: { code: "US", name: "United States" } as { code: string; name: string } | null,
  address: "410 Market St, San Francisco, CA" as string | null,
  intel: null as unknown,
}));

function builder(table: string) {
  const eqs: Array<[string, unknown]> = [];
  const neqs: Array<[string, unknown]> = [];
  const ins: Array<[string, unknown[]]> = [];
  const col = (k: string) => k.split("->>").pop()!;
  const rows = () =>
    (h.db[table] ?? []).filter(
      (r) => eqs.every(([k, v]) => r[col(k)] === v) && neqs.every(([k, v]) => r[col(k)] !== v) && ins.every(([k, vs]) => vs.includes(r[col(k)])),
    );
  const b: Record<string, unknown> = {
    select: () => b,
    eq: (k: string, v: unknown) => (eqs.push([k, v]), b),
    neq: (k: string, v: unknown) => (neqs.push([k, v]), b),
    in: (k: string, vs: unknown[]) => (ins.push([k, vs]), b),
    gte: () => b,
    order: () => b,
    limit: () => b,
    maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
    then: (res: (v: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(res),
    upsert: async (row: Row) => {
      h.upserts.push({ table, row });
      const list = (h.db[table] ??= []);
      const i = list.findIndex((r) => r.platform === row.platform && r.object_id === row.object_id);
      if (i >= 0) list[i] = { ...list[i], ...row };
      else list.push(row);
      return { error: null };
    },
  };
  return b;
}

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: (tid: string) => {
    h.scopes.push(tid);
    return { from: (table: string) => builder(table) };
  },
  tenantRpc: (tid: string, name: string, args: unknown) => {
    h.scopes.push(tid);
    return h.rpc(tid, name, args);
  },
}));
vi.mock("@/services/tools/google-ads/_client", () => ({
  gadsGetCampaign: async (_t: string, id: string) => ({ campaign_id: id, ...h.campaign }),
}));
vi.mock("@/services/tools/google-ads/write/replace_geo_targets", async (orig) => ({
  ...(await orig<typeof import("@/services/tools/google-ads/write/replace_geo_targets")>()),
  readGoogleGeoTargets: async () => h.googleTargets,
}));
vi.mock("@/services/tools/meta-ads/write/replace_ad_set_geo", async (orig) => ({
  ...(await orig<typeof import("@/services/tools/meta-ads/write/replace_ad_set_geo")>()),
  readMetaAdSetTargeting: async () => ({ name: null, targeting: h.metaTargeting }),
  verifyMetaPlaces: h.verifyMeta,
}));
vi.mock("../places", async (orig) => ({
  ...(await orig<typeof import("../places")>()),
  googlePlaceNames: h.googleNames,
  readGooglePlaces: h.readGooglePlaces,
  resolvePlace: h.resolvePlace,
}));
vi.mock("../country", async (orig) => ({
  ...(await orig<typeof import("../country")>()),
  businessCountry: async () => h.country,
  businessAddress: async () => h.address,
}));
vi.mock("@/services/approvals/decide-service", () => ({ decideOnDecision: h.decide }));
vi.mock("@/services/tools/growth/marketplace_intelligence", () => ({ getMarketplaceIntel: async () => h.intel }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));
vi.mock("@/services/tools/google-ads/write/_launch-defaults", () => ({ readBusinessCountryGeoId: async () => 2840 }));

import { geoFingerprint, type GoogleGeoTargets } from "@/services/tools/google-ads/write/replace_geo_targets";
import { metaGeoFingerprint } from "@/services/tools/meta-ads/write/replace_ad_set_geo";
import { locationStatus, locationSuggestions, markLocationsNoted, newestCgoCampaign, rankOrderLocations, saveLocations, locationNoteItems } from "../service";
import type { TenantId } from "@/services/tenant-client";

const US_ONLY: GoogleGeoTargets = { level: "campaign", owners: [{ resource: "customers/1/campaigns/555", criteria: [{ resource_name: "c/1", geo_id: 2840 }] }] };
const FP = geoFingerprint(US_ONLY);
const tid = TENANT as TenantId;

function seedGoogleLaunch() {
  h.db.decisions = [
    { id: "d-new", tenant_id: TENANT, status: "acted", approved_by_source: "cgo", decision_class: "google_ads.create_campaign", dispatched_at: "2026-10-02T10:00:00Z", channel_type: "SEARCH", name: "Zavi · Coffee" },
    { id: "d-old", tenant_id: TENANT, status: "acted", approved_by_source: "cgo", decision_class: "google_ads.create_campaign", dispatched_at: "2026-09-02T10:00:00Z", channel_type: "SEARCH", name: "Old" },
    { id: "d-yt", tenant_id: TENANT, status: "acted", approved_by_source: "cgo", decision_class: "google_ads.create_campaign", dispatched_at: "2026-10-02T11:00:00Z", channel_type: "DEMAND_GEN", name: "Video" },
  ];
  h.db.channel_actions = [];
  h.db.ad_budget_reservations = [
    { idem_key: "d-new:create", object_id: "555" },
    { idem_key: "d-old:create", object_id: "444" },
    { idem_key: "d-yt:create", object_id: "666" },
  ];
}

beforeEach(() => {
  h.db = {};
  h.scopes = [];
  h.upserts = [];
  h.rpc.mockReset();
  h.rpc.mockResolvedValue({ data: "33333333-3333-4333-8333-333333333333", error: null });
  h.decide.mockReset();
  h.decide.mockResolvedValue({ code: "ok" });
  h.campaign = { channel_type: "SEARCH", campaign_resource: "customers/1/campaigns/555" };
  h.googleTargets = US_ONLY;
  h.googleNames.mockReset();
  h.googleNames.mockImplementation(async (_t: string, ids: number[]) =>
    ids.map((id) => (id === 2840 ? { id: "2840", name: "United States", kind: "Country", country_code: "US" } : { id: String(id), name: `City ${id}`, kind: "City", country_code: "US" })),
  );
  h.readGooglePlaces.mockReset();
  h.readGooglePlaces.mockImplementation(async (_t: string, ids: number[]) => new Map(ids.filter((id) => id !== 999).map((id) => [id, { id: String(id), name: id === 2840 ? "United States" : `City ${id}`, kind: id === 2840 ? "Country" : "City", country_code: "US" }])));
  h.resolvePlace.mockReset();
  h.resolvePlace.mockImplementation(async (_t: string, _p: string, label: string) => ({ id: label === "San Francisco" || label.startsWith("410") ? "1014221" : label === "Oakland" ? "1014044" : "1014000", name: `${label}, CA`, kind: "City" }));
  h.verifyMeta.mockReset();
  h.country = { code: "US", name: "United States" };
  h.address = "410 Market St, San Francisco, CA";
  h.intel = { configured: false, tenant_id: TENANT };
  seedGoogleLaunch();
});

describe("the campaign is server-derived", () => {
  it("newest CGO launch per channel: search for Google Ads, Demand Gen for YouTube Ads", async () => {
    expect((await newestCgoCampaign(TENANT, "google_ads"))?.object_id).toBe("555");
    expect((await newestCgoCampaign(TENANT, "youtube_ads"))?.object_id).toBe("666");
    expect(await newestCgoCampaign(TENANT, "meta_ads")).toBeNull();
  });

  it("a launch the founder approved is never the card's campaign", async () => {
    h.db.decisions = h.db.decisions.map((d) => ({ ...d, approved_by_source: null }));
    expect(await newestCgoCampaign(TENANT, "google_ads")).toBeNull();
  });
});

describe("the card", () => {
  it("country-wide and no choice: Needs you, with the country and the order tip", async () => {
    h.intel = {
      configured: true,
      regions: [
        { region_key: "san francisco", region_label: "San Francisco", bookings_n: 34, suppressed: false },
        { region_key: "oakland", region_label: "Oakland", bookings_n: 12, suppressed: false },
        { region_key: "__other__", region_label: "Other locations", bookings_n: 54, suppressed: false },
      ],
    };
    h.db.tenant_db_config = [{ type: "postgres" }];
    const s = await locationStatus(TENANT, "google_ads");
    expect(s).toMatchObject({ state: "needs_you", country: { code: "US" }, campaign: { id: "555" }, targeting: "single", fingerprint: FP, order_cities: ["San Francisco", "Oakland"] });
  });

  it("no CGO campaign: nothing to show", async () => {
    h.db.decisions = [];
    expect(await locationStatus(TENANT, "google_ads")).toEqual({ state: "none" });
  });

  it("an unsupported campaign type says so and offers no picker", async () => {
    h.campaign = { channel_type: "LOCAL_SERVICES", campaign_resource: "x" };
    expect((await locationStatus(TENANT, "google_ads")).state).toBe("unsupported");
  });

  it("after keeping the country it is saved, not asked again", async () => {
    await saveLocations(tid, USER, "google_ads", { campaign_id: "555", fingerprint: FP, places: [] });
    expect((await locationStatus(TENANT, "google_ads")).state).toBe("saved");
  });
});

describe("the save", () => {
  it("empty on a country-wide campaign keeps the country: recorded, nothing sent to the platform", async () => {
    const r = await saveLocations(tid, USER, "google_ads", { campaign_id: "555", fingerprint: FP, places: [] });
    expect(r).toMatchObject({ state: "country", decision_id: null, approved: false });
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.decide).not.toHaveBeenCalled();
    expect(h.upserts[0].row).toMatchObject({ state: "country", object_id: "555", platform: "google", chosen_by: USER });
  });

  it("places: ONE replace decision on THAT campaign, founder origin, no run, approved by the founder's Save", async () => {
    const r = await saveLocations(tid, USER, "google_ads", { campaign_id: "555", fingerprint: FP, places: [{ id: "1014221" }, { id: "1014044" }] });
    expect(h.rpc).toHaveBeenCalledTimes(1);
    const [scope, name, args] = h.rpc.mock.calls[0] as [string, string, { p_agent_run_id: unknown; p_decision_class: string; p_body: Record<string, unknown> }];
    expect(scope).toBe(TENANT);
    expect(name).toBe("emit_decision");
    expect(args.p_agent_run_id).toBeNull();
    expect(args.p_decision_class).toBe("google_ads.replace_geo_targets_review");
    expect(args.p_body).toMatchObject({
      campaign_id: "555",
      level: "campaign",
      location_ids: [1014221, 1014044],
      before_names: ["United States"],
      expected_fingerprint: FP,
      origin: "user_initiated_ledger",
    });
    expect(args.p_body.place_names).toEqual(["City 1014221", "City 1014044"]);
    expect(h.decide).toHaveBeenCalledWith({ decision_id: r.decision_id, tenant_id: TENANT, action: "approve", actor: { user_id: USER } });
    expect(r).toMatchObject({ state: "places", approved: true });
  });

  it("only the newest CGO campaign can be changed: an older or foreign id is refused", async () => {
    await expect(saveLocations(tid, USER, "google_ads", { campaign_id: "444", fingerprint: FP, places: [{ id: "1014221" }] })).rejects.toMatchObject({
      code: "ad_locations_campaign_changed",
    });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("a stale card (targeting changed since it was shown) is refused", async () => {
    await expect(saveLocations(tid, USER, "google_ads", { campaign_id: "555", fingerprint: "f".repeat(64), places: [{ id: "1014221" }] })).rejects.toMatchObject({
      code: "ad_locations_campaign_changed",
    });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("a place Google does not know is refused, never dropped", async () => {
    await expect(saveLocations(tid, USER, "google_ads", { campaign_id: "555", fingerprint: FP, places: [{ id: "1014221" }, { id: "999" }] })).rejects.toMatchObject({
      code: "ad_locations_bad_place",
    });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("more than 50 places is refused, never sliced", async () => {
    const places = Array.from({ length: 51 }, (_, i) => ({ id: String(1000 + i) }));
    await expect(saveLocations(tid, USER, "google_ads", { campaign_id: "555", fingerprint: FP, places })).rejects.toMatchObject({ code: "ad_locations_too_many" });
  });

  it("mixed Demand Gen ad groups need the founder's explicit apply-to-all", async () => {
    h.campaign = { channel_type: "DEMAND_GEN", campaign_resource: "customers/1/campaigns/666" };
    const mixed: GoogleGeoTargets = {
      level: "ad_group",
      owners: [
        { resource: "ag/1", criteria: [{ resource_name: "a", geo_id: 2840 }] },
        { resource: "ag/2", criteria: [{ resource_name: "b", geo_id: 2124 }] },
      ],
    };
    h.googleTargets = mixed;
    const fp = geoFingerprint(mixed);
    await expect(saveLocations(tid, USER, "youtube_ads", { campaign_id: "666", fingerprint: fp, places: [{ id: "1014221" }] })).rejects.toMatchObject({ code: "ad_locations_mixed" });
    await saveLocations(tid, USER, "youtube_ads", { campaign_id: "666", fingerprint: fp, places: [{ id: "1014221" }], apply_to_all: true });
    expect((h.rpc.mock.calls[0][2] as { p_body: Record<string, unknown> }).p_body).toMatchObject({ level: "ad_group", scope: "all_ad_groups", campaign_id: "666" });
  });

  it("an approve that does not go through leaves the change staged and says so", async () => {
    h.decide.mockResolvedValue({ code: "forbidden" });
    const r = await saveLocations(tid, USER, "google_ads", { campaign_id: "555", fingerprint: FP, places: [{ id: "1014221" }] });
    expect(r.approved).toBe(false);
  });

  it("Meta: the ad set's places, checked with Meta, as one replace_ad_set_geo decision", async () => {
    h.db.decisions = [{ id: "m-1", tenant_id: TENANT, status: "acted", approved_by_source: "cgo", decision_class: "meta_ads.create_ad_set", dispatched_at: "2026-10-02T10:00:00Z", channel_type: null, name: "Zavi · Coffee" }];
    h.db.ad_budget_reservations = [{ idem_key: "m-1:create", object_id: "777" }];
    h.metaTargeting = { geo_locations: { countries: ["US"] } };
    h.verifyMeta.mockImplementation(async (_t: string, places: Array<{ type: string; key: string }>) => places.map((p) => ({ ...p, name: `Meta ${p.key}` })));
    const fp = metaGeoFingerprint({ countries: ["US"] });
    expect((await locationStatus(TENANT, "meta_ads")).state).toBe("needs_you");
    await saveLocations(tid, USER, "meta_ads", { campaign_id: "777", fingerprint: fp, places: [{ id: "city:2420379", name: "client-typed name" }] });
    const args = h.rpc.mock.calls[0][2] as { p_decision_class: string; p_body: Record<string, unknown> };
    expect(args.p_decision_class).toBe("meta_ads.replace_ad_set_geo_review");
    expect(args.p_body).toMatchObject({ ad_set_id: "777", places: [{ type: "city", key: "2420379", name: "Meta 2420379" }], origin: "user_initiated_ledger", expected_fingerprint: fp });
  });
});

describe("suggestions", () => {
  it("a confirmed orders mapping: order cities pre-ticked with their share, plus the address (not ticked)", async () => {
    h.db.tenant_db_config = [{ type: "postgres" }];
    h.intel = {
      configured: true,
      regions: [
        { region_key: "san francisco", region_label: "San Francisco", bookings_n: 34, suppressed: false },
        { region_key: "oakland", region_label: "Oakland", bookings_n: 12, suppressed: false },
        { region_key: "rest", region_label: "Elsewhere", bookings_n: 54, suppressed: true },
      ],
    };
    const s = await locationSuggestions(TENANT, "google_ads");
    expect(s.orders).toBe("confirmed");
    expect(s.places.map((p) => [p.name, p.source, p.reason])).toEqual([
      ["San Francisco, CA", "orders", "34% of your orders in the last 90 days"],
      ["Oakland, CA", "orders", "12% of your orders"],
    ]);
    expect(s.picked).toEqual(["1014221", "1014044"]);
  });

  it("no database: the address only, nothing pre-ticked", async () => {
    const s = await locationSuggestions(TENANT, "google_ads");
    expect(s.orders).toBe("no_db");
    expect(s.places).toHaveLength(1);
    expect(s.places[0]).toMatchObject({ id: "1014221", kind: "City", source: "address", reason: "Where you are" });
    expect(s.picked).toEqual([]);
  });

  it("a database whose orders mapping is not confirmed suggests nothing from it", async () => {
    h.db.tenant_db_config = [{ type: "postgres" }];
    const s = await locationSuggestions(TENANT, "google_ads");
    expect(s.orders).toBe("not_set_up");
    expect(s.places.every((p) => p.source === "address")).toBe(true);
  });

  it("ranking: sentinels and suppressed cells are never suggested, but count in the shares", () => {
    expect(
      rankOrderLocations(
        [
          { label: "A", key: "a", bookings_n: 50 },
          { label: "Other", key: "__other__", bookings_n: 40 },
          { label: "B", key: "b", bookings_n: 10, suppressed: true },
        ],
        (k) => k.startsWith("__"),
      ),
    ).toEqual([{ label: "A", share: 50 / 60 }]);
  });
});

describe("the CGO note", () => {
  it("finds a country-wide campaign without marking it; once the note is stored and marked, never again", async () => {
    const first = await locationNoteItems(TENANT);
    expect(first.map((x) => x.channel)).toContain("google_ads");
    expect(h.upserts).toEqual([]);
    expect((await locationNoteItems(TENANT)).map((x) => x.channel)).toContain("google_ads");
    await markLocationsNoted(TENANT, first.filter((x) => x.channel === "google_ads"));
    expect(h.upserts.some((u) => u.row.state === "noted" && u.row.object_id === "555")).toBe(true);
    expect((await locationNoteItems(TENANT)).map((x) => x.channel)).not.toContain("google_ads");
  });

  it("a burst of YouTube launches never hides the newest Google Ads campaign (channel filtered in the query)", async () => {
    h.db.decisions = [
      ...h.db.decisions,
      ...Array.from({ length: 12 }, (_, i) => ({ id: `yt-${i}`, tenant_id: TENANT, status: "acted", approved_by_source: "cgo", decision_class: "google_ads.create_campaign", dispatched_at: `2026-10-03T0${i % 10}:00:00Z`, channel_type: "DEMAND_GEN", name: "v" })),
    ];
    expect((await newestCgoCampaign(TENANT, "google_ads"))?.object_id).toBe("555");
  });
});

describe("tenant isolation", () => {
  it("every read and write is scoped to the caller's tenant, and nothing else", async () => {
    await locationStatus(TENANT, "google_ads");
    await saveLocations(tid, USER, "google_ads", { campaign_id: "555", fingerprint: FP, places: [{ id: "1014221" }] });
    expect(h.scopes.length).toBeGreaterThan(0);
    expect(new Set(h.scopes)).toEqual(new Set([TENANT]));
  });
});
