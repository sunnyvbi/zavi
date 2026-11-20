
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExpectedToolError } from "@/services/tools/types";

type Obj = { id: string; kind: "campaign" | "adset" | "ad"; name: string; status: string; parent: string | null; daily_budget?: number; creative?: string; targeting?: Record<string, unknown> };

const g = vi.hoisted(() => ({
  objs: new Map<string, Obj>(),
  posts: [] as Array<{ path: string; params: Record<string, string> }>,
  next: 1200009000,
  refuseCreativeIds: new Set<string>(),
  ignoreTargeting: false,
}));

function graphError(subcode: number): ExpectedToolError {
  return new ExpectedToolError(
    "meta_ads_write_failed",
    `Meta Ads write failed: 400 {"error":{"message":"Invalid parameter","type":"OAuthException","code":100,"error_subcode":${subcode},"is_transient":false,"error_user_title":"Creative should not include standard enhancements"}}`,
  );
}

vi.mock("../../_client", () => ({
  getAdAccountCurrency: async () => "USD",
  metaAdsCreds: async () => ({ ad_account_id: "act_1", access_token: "x" }),
  fbGet: async (_t: string, path: string, params: Record<string, unknown>) => {
    const [id, edge] = path.split("/");
    if (id === "act_1" && edge === "campaigns") {
      const f = JSON.parse(String(params.filtering ?? "[]"))[0]?.value ?? "";
      return { data: [...g.objs.values()].filter((o) => o.kind === "campaign" && o.name.includes(f)).map((o) => ({ id: o.id, name: o.name })) };
    }
    if (edge === "ads" || edge === "adsets") {
      const kind = edge === "ads" ? "ad" : "adset";
      return { data: [...g.objs.values()].filter((o) => o.kind === kind && o.parent === id).map((o) => ({ id: o.id, name: o.name, status: o.status })) };
    }
    const o = g.objs.get(id!);
    if (!o) return {};
    if (params.fields === "name,targeting") return { name: o.name, targeting: o.targeting ?? { geo_locations: { countries: ["US"] }, age_min: 25 } };
    if (String(params.fields).startsWith("creative")) return { creative: { id: o.creative, degrees_of_freedom_spec: { creative_features_spec: { standard_enhancements: { enroll_status: "OPT_IN" }, image_touchups: { enroll_status: "OPT_IN" } } } } };
    return { id: o.id, name: o.name, status: o.status, effective_status: o.status, daily_budget: o.daily_budget };
  },
  fbPost: async (_t: string, path: string, params: Record<string, string>) => {
    g.posts.push({ path, params });
    const [id, edge] = path.split("/");
    const nid = () => String(g.next++);
    if (edge === "copies") {
      const src = g.objs.get(id!)!;
      if (src.kind === "ad") {
        const n = nid();
        g.objs.set(n, { ...src, id: n, parent: params.adset_id!, status: "PAUSED", creative: `clean-${src.creative}` });
        return { copied_ad_id: n };
      }
      const deep = params.deep_copy === "true";
      const rename = JSON.parse(params.rename_options ?? "{}");
      const suffix = rename.rename_strategy === "NO_RENAME" ? "" : (rename.rename_suffix ?? " - Copy");
      const kids = (p: string) => [...g.objs.values()].filter((o) => o.parent === p);
      if (deep) {
        const all = (p: string): Obj[] => kids(p).flatMap((k) => [k, ...all(k.id)]);
        if (all(src.id).some((k) => k.kind === "ad" && g.refuseCreativeIds.has(k.creative ?? ""))) throw graphError(3858504);
      }
      const n = nid();
      g.objs.set(n, { ...src, id: n, name: `${src.name}${suffix}`, status: "PAUSED", parent: params.campaign_id ?? src.parent });
      return src.kind === "adset" ? { copied_adset_id: n } : { copied_campaign_id: n };
    }
    if (id === "act_1" && edge === "ads") {
      const creative = JSON.parse(params.creative!).creative_id as string;
      if (g.refuseCreativeIds.has(`id-reject:${creative}`)) throw graphError(3858504);
      const n = nid();
      g.objs.set(n, { id: n, kind: "ad", name: params.name!, status: params.status!, parent: params.adset_id!, creative });
      return { id: n };
    }
    const o = g.objs.get(id!)!;
    if (params.targeting && !g.ignoreTargeting) o.targeting = JSON.parse(params.targeting);
    if (params.status) o.status = params.status;
    if (params.daily_budget) o.daily_budget = Number(params.daily_budget);
    if (params.name) o.name = params.name;
    return { success: true };
  },
}));
vi.mock("../_library-ad-capability", () => ({ resolveMetaAdCapability: async () => ({ ok: false }) }));
vi.mock("../create_library_ad", () => ({ capabilityRefusal: () => new Error("no") }));

import { metaDuplicate, missingCopies, isStandardEnhancementsRefusal } from "../launch";
import { withoutStandardEnhancements } from "../_launch-shapers";

const put = (o: Obj) => g.objs.set(o.id, o);
const TAG = "zvabcdef0123";

beforeEach(() => {
  g.objs.clear();
  g.posts = [];
  g.next = 1200009000;
  g.refuseCreativeIds.clear();
  put({ id: "1200000100", kind: "campaign", name: "Camp", status: "ACTIVE", parent: null, daily_budget: 5000 });
  put({ id: "1200000200", kind: "adset", name: "Gig Rentals Purchase", status: "ACTIVE", parent: "1200000100", daily_budget: 2000 });
  put({ id: "1200000301", kind: "ad", name: "Ad A", status: "ACTIVE", parent: "1200000200", creative: "5500000001" });
  put({ id: "1200000302", kind: "ad", name: "Ad B", status: "ACTIVE", parent: "1200000200", creative: "5500000002" });
  put({ id: "1200000303", kind: "ad", name: "Ad Off", status: "PAUSED", parent: "1200000200", creative: "5500000003" });
  g.refuseCreativeIds.add("5500000001").add("5500000002").add("5500000003");
});

describe("metaDuplicate: a copy Meta's standard-enhancements refusal cannot break", () => {
  it("an ad set copy is shallow and its live ads go in on their source creative ids, then it goes live at its own budget", async () => {
    const r = await metaDuplicate("t", { level: "adset", source_id: "1200000200", campaign_id: "1200000100", daily_budget_usd: 189.57, name: "Gig Rentals Purchase (copy)", tag: TAG });
    expect(r.status).toBe("ACTIVE");
    expect(g.posts.find((p) => p.path === "1200000200/copies")!.params.deep_copy).toBe("false");
    const copy = g.objs.get(r.object_id)!;
    expect(copy.daily_budget).toBe(18957);
    const ads = [...g.objs.values()].filter((o) => o.parent === r.object_id);
    expect(ads.map((a) => [a.name, a.creative, a.status]).sort()).toEqual([
      ["Ad A", "5500000001", "ACTIVE"],
      ["Ad B", "5500000002", "ACTIVE"],
    ]);
    const order = g.posts.map((p) => `${p.path}:${p.params.status ?? ""}`);
    expect(order.filter((x) => x.startsWith("act_1/ads")).every((x) => x.endsWith("PAUSED"))).toBe(true);
    expect(order[order.length - 1]).toBe(`${r.object_id}:ACTIVE`);
  });

  it("when Meta refuses even the creative id, the ad is copied once more with the bundle dropped", async () => {
    g.refuseCreativeIds.add("id-reject:5500000001");
    const r = await metaDuplicate("t", { level: "adset", source_id: "1200000200", campaign_id: "1200000100", daily_budget_usd: 50, name: "x", tag: TAG });
    const fallback = g.posts.find((p) => p.path === "1200000301/copies")!;
    expect(fallback.params.adset_id).toBe(r.object_id);
    expect(JSON.parse(fallback.params.creative_parameters!).degrees_of_freedom_spec.creative_features_spec).toEqual({ image_touchups: { enroll_status: "OPT_IN" } });
    expect([...g.objs.values()].filter((o) => o.parent === r.object_id && o.status === "ACTIVE")).toHaveLength(2);
  });

  it("a campaign copy is shallow; its live ad sets are copied in without renaming, and their live ads after", async () => {
    put({ id: "1200000201", kind: "adset", name: "Set Off", status: "PAUSED", parent: "1200000100" });
    const r = await metaDuplicate("t", { level: "campaign", source_id: "1200000100", campaign_id: "1200000100", daily_budget_usd: 80, name: "Camp (copy)", tag: TAG });
    expect(g.posts.find((p) => p.path === "1200000100/copies")!.params.deep_copy).toBe("false");
    const setCopy = g.posts.find((p) => p.path === "1200000200/copies")!;
    expect(setCopy.params).toMatchObject({ deep_copy: "false", campaign_id: r.object_id, status_option: "PAUSED" });
    expect(JSON.parse(setCopy.params.rename_options!)).toEqual({ rename_strategy: "NO_RENAME" });
    expect(g.posts.some((p) => p.path === "1200000201/copies")).toBe(false);
    const sets = [...g.objs.values()].filter((o) => o.parent === r.object_id);
    expect(sets.map((s) => [s.name, s.status])).toEqual([["Gig Rentals Purchase", "ACTIVE"]]);
    expect([...g.objs.values()].filter((o) => o.parent === sets[0]!.id && o.status === "ACTIVE")).toHaveLength(2);
    expect(g.objs.get(r.object_id)!.status).toBe("ACTIVE");
  });

  it("a retry finds its copy by the tag and adds only the ads the first attempt did not make", async () => {
    put({ id: "1200000500", kind: "adset", name: `Gig Rentals Purchase (copy) · ${TAG}`, status: "PAUSED", parent: "1200000100", daily_budget: 1000 });
    put({ id: "1200000501", kind: "ad", name: "Ad A", status: "PAUSED", parent: "1200000500", creative: "5500000001" });
    const r = await metaDuplicate("t", { level: "adset", source_id: "1200000200", campaign_id: "1200000100", daily_budget_usd: 10, name: "Gig Rentals Purchase (copy)", tag: TAG });
    expect(r.reused).toBe(true);
    expect(g.posts.filter((p) => p.path.endsWith("/copies"))).toHaveLength(0);
    expect(g.posts.filter((p) => p.path === "act_1/ads").map((p) => p.params.name)).toEqual(["Ad B"]);
    expect([...g.objs.values()].filter((o) => o.parent === "1200000500" && o.status === "ACTIVE")).toHaveLength(2);
  });

  it("one ad Meta refuses outright is left out and named; the copy goes live with the rest", async () => {
    g.objs.get("1200000302")!.creative = undefined;
    const r = await metaDuplicate("t", { level: "adset", source_id: "1200000200", campaign_id: "1200000100", daily_budget_usd: 10, name: "x", tag: TAG });
    expect(r.status).toBe("ACTIVE");
    expect(r.skipped_ads).toEqual(["1200000302"]);
    expect([...g.objs.values()].filter((o) => o.parent === r.object_id).map((a) => a.name)).toEqual(["Ad A"]);
  });

  it("a campaign copy: one ad set whose ads Meta all refuses stays off; the rest of the copy goes live", async () => {
    put({ id: "1200000202", kind: "adset", name: "Set Two", status: "ACTIVE", parent: "1200000100" });
    put({ id: "1200000304", kind: "ad", name: "Ad Bad", status: "ACTIVE", parent: "1200000202" });
    const r = await metaDuplicate("t", { level: "campaign", source_id: "1200000100", campaign_id: "1200000100", daily_budget_usd: 80, name: "Camp (copy)", tag: TAG });
    expect(r.status).toBe("ACTIVE");
    expect(r.skipped_ads).toEqual(["1200000304"]);
    const sets = [...g.objs.values()].filter((o) => o.parent === r.object_id);
    expect(sets.map((x) => [x.name, x.status]).sort()).toEqual([
      ["Gig Rentals Purchase", "ACTIVE"],
      ["Set Two", "PAUSED"],
    ]);
  });

  it("a campaign whose live ad sets have no live ad: the copy is switched off, never left live with nothing in it", async () => {
    g.objs.get("1200000301")!.status = "PAUSED";
    g.objs.get("1200000302")!.status = "PAUSED";
    const e = await metaDuplicate("t", { level: "campaign", source_id: "1200000100", campaign_id: "1200000100", daily_budget_usd: 80, name: "Camp (copy)", tag: TAG }).catch((x) => x);
    expect(e.code).toBe("meta_ads_launch_switched_off");
    expect(e.message).toContain("no ad switched on");
    const copy = [...g.objs.values()].find((o) => o.kind === "campaign" && o.name.includes(TAG))!;
    expect(copy.status).toBe("PAUSED");
  });

  it("no ad could be copied at all: the copy is switched off and the refusal comes out", async () => {
    g.objs.get("1200000301")!.creative = undefined;
    g.objs.get("1200000302")!.creative = undefined;
    const e = await metaDuplicate("t", { level: "adset", source_id: "1200000200", campaign_id: "1200000100", daily_budget_usd: 10, name: "x", tag: TAG }).catch((x) => x);
    expect(e).toBeInstanceOf(ExpectedToolError);
    expect(e.code).toBe("meta_ads_launch_switched_off");
    const copy = [...g.objs.values()].find((o) => o.kind === "adset" && o.name.includes(TAG))!;
    expect(copy.status).toBe("PAUSED");
  });
});

describe("pure parts", () => {
  it("missingCopies counts copies per name, so duplicates names are made only as often as missing", () => {
    const c = (id: string, name: string) => ({ id, name, status: "ACTIVE" });
    expect(missingCopies([c("1", "a"), c("2", "a"), c("3", "b")], [c("9", "a")]).map((x) => x.id)).toEqual(["2", "3"]);
  });
  it("the refusal is recognised by its subcode; the bundle is dropped and the other features kept", () => {
    expect(isStandardEnhancementsRefusal(graphError(3858504))).toBe(true);
    expect(isStandardEnhancementsRefusal(graphError(1885183))).toBe(false);
    expect(withoutStandardEnhancements({ creative_features_spec: { standard_enhancements: { enroll_status: "OPT_IN" }, text_optimizations: { enroll_status: "OPT_OUT" } } })).toEqual({
      creative_features_spec: { text_optimizations: { enroll_status: "OPT_OUT" } },
    });
    expect(withoutStandardEnhancements(undefined)).toEqual({ creative_features_spec: {} });
  });
});

describe("metaDuplicate with places: a region copy", () => {
  beforeEach(() => {
    g.ignoreTargeting = false;
  });
  const places = [{ type: "region" as const, key: "4401", name: "Northfield, United States" }];

  it("the copy shows only in its own places, keeps every other targeting key, and is set before it goes live", async () => {
    const r = await metaDuplicate("t", { level: "adset", source_id: "1200000200", campaign_id: "1200000100", daily_budget_usd: 40, name: "Weekly clean (copy, Northfield)", tag: TAG, places });
    expect(r.status).toBe("ACTIVE");
    const copy = g.objs.get(r.object_id)!;
    expect(copy.targeting).toEqual({ geo_locations: { regions: [{ key: "4401" }] }, age_min: 25 });
    expect(g.objs.get("1200000200")!.targeting).toBeUndefined();
    const placesAt = g.posts.findIndex((p) => p.path === r.object_id && p.params.targeting);
    const onAt = g.posts.findIndex((p) => p.path === r.object_id && p.params.status === "ACTIVE");
    expect(placesAt).toBeGreaterThan(-1);
    expect(placesAt).toBeLessThan(onAt);
  });

  it("Meta does not show the new places: the copy stays off and the launch fails", async () => {
    g.ignoreTargeting = true;
    await expect(
      metaDuplicate("t", { level: "adset", source_id: "1200000200", campaign_id: "1200000100", daily_budget_usd: 40, name: "Weekly clean (copy, Northfield)", tag: TAG, places }),
    ).rejects.toMatchObject({ code: "meta_ads_launch_switched_off" });
    const copy = [...g.objs.values()].find((o) => o.kind === "adset" && o.name.includes(TAG))!;
    expect(copy.status).toBe("PAUSED");
  });

  it("the source's place exclusions do not come along to the copy's new places", async () => {
    g.objs.get("1200000200")!.targeting = { geo_locations: { countries: ["US"] }, excluded_geo_locations: { cities: [{ key: "777" }] }, age_min: 30 };
    const r = await metaDuplicate("t", { level: "adset", source_id: "1200000200", campaign_id: "1200000100", daily_budget_usd: 40, name: "Weekly clean (copy, Northfield)", tag: TAG, places });
    expect(g.objs.get(r.object_id)!.targeting).toEqual({ geo_locations: { regions: [{ key: "4401" }] }, age_min: 30, targeting_automation: { advantage_audience: 0 } });
  });

  it("without places the copy keeps its source's targeting untouched", async () => {
    const r = await metaDuplicate("t", { level: "adset", source_id: "1200000200", campaign_id: "1200000100", daily_budget_usd: 40, name: "Weekly clean (copy)", tag: TAG });
    expect(g.posts.some((p) => p.path === r.object_id && p.params.targeting)).toBe(false);
  });
});

describe("metaDuplicate: a copied ad set gets the server's audience mode before it goes on", () => {
  const dup = () => metaDuplicate("t", { level: "adset", source_id: "1200000200", campaign_id: "1200000100", daily_budget_usd: 20, name: "Retarget (copy)", tag: TAG });

  it("a retargeting source running Advantage audience 1 is copied exact: flag 0, expansion off", async () => {
    g.objs.get("1200000200")!.targeting = { geo_locations: { countries: ["US"] }, custom_audiences: [{ id: "120240072436710168" }], targeting_automation: { advantage_audience: 1 } };
    const r = await dup();
    expect(r.status).toBe("ACTIVE");
    expect(g.objs.get(r.object_id)!.targeting).toEqual({
      geo_locations: { countries: ["US"] },
      custom_audiences: [{ id: "120240072436710168" }],
      targeting_automation: { advantage_audience: 0 },
      targeting_relaxation_types: { custom_audience: 0, lookalike: 0 },
    });
  });

  it("a copy at flag 0 with no expansion setting on the read gets expansion turned off, other automation kept", async () => {
    g.objs.get("1200000200")!.targeting = { geo_locations: { countries: ["US"] }, custom_audiences: [{ id: "7" }], targeting_automation: { advantage_audience: 0, individual_setting: { age: 1 } } };
    const r = await dup();
    expect(g.objs.get(r.object_id)!.targeting).toMatchObject({
      targeting_automation: { advantage_audience: 0, individual_setting: { age: 1 } },
      targeting_relaxation_types: { custom_audience: 0, lookalike: 0 },
    });
  });

  it("a copy already on the right mode is not rewritten", async () => {
    g.objs.get("1200000200")!.targeting = { geo_locations: { countries: ["US"] }, targeting_automation: { advantage_audience: 1 } };
    const r = await dup();
    expect(g.posts.filter((p) => p.path === r.object_id && p.params.targeting)).toHaveLength(0);
  });

  it("switches the copy off when Meta does not keep the mode", async () => {
    g.objs.get("1200000200")!.targeting = { geo_locations: { countries: ["US"] }, custom_audiences: [{ id: "1" }] };
    g.ignoreTargeting = true;
    try {
      await expect(dup()).rejects.toThrow(/switched off/);
    } finally {
      g.ignoreTargeting = false;
    }
  });

  it("refuses a copy that names the retired video_feeds placement", async () => {
    g.objs.get("1200000200")!.targeting = { geo_locations: { countries: ["US"] }, facebook_positions: ["feed", "video_feeds"] };
    await expect(dup()).rejects.toThrow(/video_feeds/);
  });
});
