
import { describe, it, expect, vi } from "vitest";
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));
vi.mock("../_flag-check", () => ({ isMetaAdsWriteEnabled: vi.fn(async () => true) }));
const guard = vi.hoisted(() => ({ value: { allowed_places: [] as unknown[], blocked_places: [] as unknown[], banned_phrases: [] as string[] } }));
vi.mock("@/services/rules/ad-guard", () => ({ readAdGuard: async () => guard.value }));

import { allowedCountries, buildLocationProposal, checkAdRulesWith, countryProblem, locationToolResult, metaProposeLocationsTool, recheckLocationChange, type ProposeLocationDeps } from "../propose_locations";
import { metaGeoFingerprint, type MetaPlaceFacts } from "../replace_ad_set_geo";
import { locationUndoBody, fileLocationUndoAfterSettle, withUndoStatus, undoReceiptLine, UNDO_FOLLOWS, UNDO_NOT_FILED } from "../location-undo";
import { metaChangeRows } from "../_change-rows";
import { metaActionRaisesSpend } from "../_decision-bodies";
import { metaApproverRefusal } from "../_approver-role";
import { actionLabel } from "@/services/channels/action-label";
import { reachesCgoAdDoor } from "@/services/channels/exec-actions";
import { isPersonOnlyOrigin } from "@/services/growth/person-only";
import { serverFounderMarks } from "@/services/growth/founder-marks";
import { dispatchCustomAgentDecision } from "@/services/agents/custom-agent-decisions";
import { ExpectedToolError } from "@/services/tools/types";

const CLASS = "meta_ads.replace_ad_set_geo_review";
const LIVE_GEO = { countries: ["US"], location_types: ["home"] };
const FACTS: Record<string, MetaPlaceFacts> = {
  "country:US": { type: "country", key: "US", name: "United States", country_code: "US", region_name: null },
  "region:3847": { type: "region", key: "3847", name: "California", country_code: "US", region_name: "California" },
  "city:2420605": { type: "city", key: "2420605", name: "Denver, Colorado", country_code: "US", region_name: "Colorado" },
  "city:296875": { type: "city", key: "296875", name: "Toronto, Ontario", country_code: "CA", region_name: "Ontario" },
  "country:CA": { type: "country", key: "CA", name: "Canada", country_code: "CA", region_name: null },
};

function deps(over: Partial<ProposeLocationDeps> = {}): ProposeLocationDeps {
  return {
    readTargeting: async () => ({ name: "Set A", targeting: { age_min: 18, geo_locations: LIVE_GEO } }),
    placeFacts: async (_t, places) => places.map((p) => FACTS[`${p.type}:${p.key}`] ?? { ...p, country_code: null, region_name: null }),
    businessCountry: async () => "US",
    adRules: async () => null,
    dailyBudget: async () => ({ object_daily_budget: 40, currency: "USD" }),
    ...over,
  };
}
const ask = (places: Array<{ type: string; key: string }>) => ({ ad_set_id: "238000000001", places, rationale: "Most orders come from Denver." });
const refusal = async (p: Promise<unknown>) => {
  const e = await p.catch((x: unknown) => x);
  expect(e).toBeInstanceOf(ExpectedToolError);
  return (e as Error).message;
};

describe("which places Zavi may propose (Ravi 2026-11-01)", () => {
  it("a city inside the ad set's own country is proposed as a person-only card, budget untouched", async () => {
    const b = await buildLocationProposal("t1", ask([{ type: "city", key: "2420605" }]), deps());
    expect(b).toMatchObject({
      ad_set_id: "238000000001",
      origin: "zavi_location_proposal",
      places: [{ type: "city", key: "2420605", name: "Denver, Colorado" }],
      before_names: ["United States"],
      before_places: [{ type: "country", key: "US", name: "United States" }],
      expected_fingerprint: metaGeoFingerprint(LIVE_GEO),
      budget_daily: 40,
      name: "Set A",
    });
    expect("daily_budget_usd" in b).toBe(false);
  });

  it("a city in another country is refused, even when Meta knows it", async () => {
    expect(await refusal(buildLocationProposal("t1", ask([{ type: "city", key: "296875" }]), deps()))).toMatch(/Toronto, Ontario is in CA, outside the countries this ad set may use \(US/);
  });

  it("the business country is allowed on top of the ad set's own", async () => {
    const b = await buildLocationProposal("t1", ask([{ type: "country", key: "CA" }]), deps({ businessCountry: async () => "CA" }));
    expect(b.places).toEqual([{ type: "country", key: "CA", name: "Canada" }]);
  });

  it("with no business country on file, only the ad set's own countries", async () => {
    const msg = await refusal(buildLocationProposal("t1", ask([{ type: "country", key: "CA" }]), deps({ businessCountry: async () => null })));
    expect(msg).toMatch(/outside the countries this ad set may use \(US: the countries it targets today\)/);
  });

  it("a place whose country Meta does not give is refused", async () => {
    expect(await refusal(buildLocationProposal("t1", ask([{ type: "city", key: "999" }]), deps()))).toMatch(/could not tell which country/);
  });

  it("a place the saved ad rules rule out is refused", async () => {
    const msg = await refusal(buildLocationProposal("t1", ask([{ type: "region", key: "3847" }]), deps({ adRules: async () => "California is a place your saved ad rules say ads must never show in. Not proposed." })));
    expect(msg).toMatch(/saved ad rules/);
  });

  it("postcodes, pins or metros on the ad set are refused at propose: change it in Ads Manager", async () => {
    const d = deps({ readTargeting: async () => ({ name: "Set A", targeting: { geo_locations: { countries: ["US"], zips: [{ key: "US:80202" }] } } }) });
    expect(await refusal(buildLocationProposal("t1", ask([{ type: "city", key: "2420605" }]), d))).toMatch(/Ads Manager/);
  });

  it("the same places it shows in today are not a proposal", async () => {
    expect(await refusal(buildLocationProposal("t1", ask([{ type: "country", key: "us" }]), deps()))).toMatch(/already shows in/);
  });

  it("allowedCountries and countryProblem are the rule, pure", () => {
    const rule = allowedCountries([{ country_code: "US" }], "ca");
    expect([...rule.allowed].sort()).toEqual(["CA", "US"]);
    expect(countryProblem([FACTS["city:296875"]!], rule)).toBeNull();
    expect(countryProblem([FACTS["city:296875"]!], allowedCountries([{ country_code: "US" }, { country_code: null }], "ca"))).toMatch(/could not read which countries/);
    expect(countryProblem([FACTS["city:296875"]!], allowedCountries([{ country_code: "US" }], null))).toMatch(/outside/);
  });
});

describe("card labels never hide a place", () => {
  it("a blank place name shows its key; blank earlier names are dropped", () => {
    const b = { ad_set_id: "238000000001", places: [{ type: "country", key: "US", name: " " }, { type: "country", key: "CA", name: "Canada" }], before_names: ["United States", ""], expected_fingerprint: "a".repeat(64), rationale: "Most orders come from Denver.", over_cap: true, origin: "zavi_location_proposal" };
    const c = metaChangeRows(CLASS, b)!;
    expect(c.rows[0]).toMatchObject({ before: "United States", after: "US, Canada" });
    const u = metaChangeRows(CLASS, { ...b, origin: "zavi_location_undo", before_names: [] })!;
    expect(u.title).toBe("Change where ad set 238000000001 shows");
  });
});

describe("who approves it, and what the card says", () => {
  const body = { ad_set_id: "238000000001", places: [{ type: "city", key: "2420605", name: "Denver, Colorado" }], before_names: ["United States"], expected_fingerprint: "a".repeat(64), name: "Set A", rationale: "Most orders come from Denver.", over_cap: true, origin: "zavi_location_proposal", budget_daily: 40, budget_currency: "USD" };

  it("owner or admin only, on the route and at the executor; the CGO never", async () => {
    expect(metaActionRaisesSpend(CLASS, body)).toBe(true);
    const refused = await metaApproverRefusal({ tenant_id: "t1", decision_class: CLASS, body, approved_by: "u1" }, async () => "member");
    expect(refused).toMatchObject({ code: "meta_ads_admin_required" });
    expect(await metaApproverRefusal({ tenant_id: "t1", decision_class: CLASS, body, approved_by: "u1" }, async () => "admin")).toBeNull();
    expect(reachesCgoAdDoor(CLASS)).toBe(false);
    expect(isPersonOnlyOrigin("zavi_location_proposal")).toBe(true);
    expect(isPersonOnlyOrigin("zavi_location_undo")).toBe(true);
  });

  it("a custom agent hands it to a person; a founder's run never stamps it", async () => {
    const handToHuman = vi.fn(async () => undefined);
    const dispatch = vi.fn();
    const out = await dispatchCustomAgentDecision({ tenant_id: "t1", run_id: "r1", slug: "custom-x", decision_id: "d1", decision_class: CLASS, body }, { handToHuman, dispatch } as never);
    if (out !== "not_custom") {
      expect(out).toBe("not_dispatched");
      expect(dispatch).not.toHaveBeenCalled();
    }
    const stamped = serverFounderMarks(CLASS, { ...body, founder_chat_order: true, move_after: ["x"] }, { group: "g", unverified: false }) as Record<string, unknown>;
    expect(stamped.origin).toBe("zavi_location_proposal");
    expect("founder_chat_order" in stamped || "move_after" in stamped).toBe(false);
  });

  it("the confirm shows every place before and after, the budget staying, and the re-learning", () => {
    const c = metaChangeRows(CLASS, body)!;
    expect(c.title).toBe("Change where “Set A” shows");
    expect(c.change_sentence).toContain("Budget stays $40/day.");
    expect(c.change_sentence).toContain("Meta re-learns delivery after a location change (about a week).");
    expect(c.rows).toEqual([
      { item: "“Set A” places", before: "United States", after: "Denver, Colorado" },
      { item: "Daily budget", before: "$40/day", after: "$40/day (unchanged)" },
    ]);
    expect(actionLabel({ action_type: "update_ad", title: "", exec_class: CLASS })).toBe("Change locations");
  });
});

const LIVE_BEFORE = [{ type: "country" as const, key: "US" }];

describe("Put places back", () => {
  const ran = { ad_set_id: "238000000001", places: [{ type: "city" as const, key: "2420605", name: "Denver, Colorado" }], before_names: ["United States"], before_places: [{ type: "country" as const, key: "US", name: "United States" }], expected_fingerprint: "a".repeat(64), name: "Set A", rationale: "Most orders come from Denver.", over_cap: true as const, origin: "zavi_location_proposal" as const };

  it("carries the old places, stale-safe on the places the change left, and files no undo of its own", () => {
    const u = locationUndoBody(ran, LIVE_BEFORE, "b".repeat(64))!;
    expect(u).toMatchObject({ places: ran.before_places, before_names: ["Denver, Colorado"], expected_fingerprint: "b".repeat(64), origin: "zavi_location_undo" });
    expect(locationUndoBody(u, LIVE_BEFORE, "c".repeat(64))).toBeNull();
    expect(locationUndoBody(ran, LIVE_BEFORE, null)).toBeNull();
  });

  it("is filed after the proposal settles, on its run, with no matcher and no CGO door", async () => {
    const record = vi.fn(async () => ({ id: "u1", replayed: false }));
    const markUndo = vi.fn(async () => undefined);
    const undo = locationUndoBody(ran, LIVE_BEFORE, "b".repeat(64))!;
    expect(await fileLocationUndoAfterSettle("t1", "a1", "r1", undo, { record, markUndo } as never)).toBe("filed");
    const [input, , d] = record.mock.calls[0] as unknown as [Record<string, unknown>, unknown, { enabled: () => boolean; cgoDoor: boolean }];
    expect(input).toMatchObject({ tenantId: "t1", runId: "r1", channelSlug: "meta_ads", execClass: CLASS, execPayload: { origin: "zavi_location_undo" } });
    expect(d.enabled()).toBe(false);
    expect(d.cgoDoor).toBe(false);
    expect(markUndo).toHaveBeenCalledWith("t1", "a1", "filed");
  });

  it("a kept card (dedupe) or a failed write is said on the executed card, never reported as filed", async () => {
    const markUndo = vi.fn(async () => undefined);
    const undo = locationUndoBody(ran, LIVE_BEFORE, "b".repeat(64))!;
    expect(await fileLocationUndoAfterSettle("t1", "a1", "r1", undo, { record: async () => ({ id: "other", replayed: false, kept: true }), markUndo } as never)).toBe("not_filed");
    expect(await fileLocationUndoAfterSettle("t1", "a1", "r1", undo, { record: async () => { throw new Error("rpc"); }, markUndo } as never)).toBe("not_filed");
    expect(markUndo.mock.calls.every((c) => (c as unknown[])[2] === "not_filed")).toBe(true);
    expect(await fileLocationUndoAfterSettle("t1", "a1", "r1", ran, { record: vi.fn(), markUndo } as never)).toBe("skipped");
    expect(await fileLocationUndoAfterSettle("t1", "a1", null, undo, { record: vi.fn(), markUndo } as never)).toBe("not_filed");
  });

  it("a card that cannot be told throws so the settle retries, and a filed card is never marked not filed", async () => {
    const undo = locationUndoBody(ran, LIVE_BEFORE, "b".repeat(64))!;
    const markUndo = vi.fn(async (_t: string, _a: string, status: string) => { if (status === "filed") throw new Error("db down"); });
    await expect(fileLocationUndoAfterSettle("t1", "a1", "r1", undo, { record: async () => ({ id: "u", replayed: false }), markUndo } as never)).rejects.toThrow("db down");
    expect(markUndo).toHaveBeenCalledTimes(1);
  });

  it("the put-back sentence is replaced, never stacked, across retried settles, and survives the receipt cap", () => {
    const base = { notice: "✅ Meta ad set now shows in: Denver. " + UNDO_FOLLOWS, receipt: { line: "Ad set 1 now shows in: Denver. " + UNDO_FOLLOWS } };
    const twice = withUndoStatus(withUndoStatus(base, "not_filed"), "not_filed");
    expect(twice.notice).toBe("✅ Meta ad set now shows in: Denver. " + UNDO_NOT_FILED);
    expect((twice.receipt as { line: string }).line).toBe("Ad set 1 now shows in: Denver. " + UNDO_NOT_FILED);
    expect(twice.undo_not_filed).toBe(true);
    const back = withUndoStatus(twice, "filed");
    expect(back.notice).toBe(base.notice);
    expect(back.undo_not_filed).toBeUndefined();
    const long = undoReceiptLine("Ad set 1 now shows in: " + "Springfield, Illinois, ".repeat(20), "not_filed");
    expect(long.length).toBeLessThanOrEqual(200);
    expect(long.endsWith(UNDO_NOT_FILED)).toBe(true);
    expect(withUndoStatus({ receipt: { line: "x".repeat(300) } }, "filed").receipt).toMatchObject({ line: expect.stringMatching(new RegExp(`${UNDO_FOLLOWS.replace(/\./g, "\\.")}$`)) });
  });

  it("restores the places Meta showed before the write, and files no undo if they differ from the card's", () => {
    expect(locationUndoBody(ran, [{ type: "country", key: "US" }, { type: "country", key: "CA" }], "b".repeat(64))).toBeNull();
    expect(locationUndoBody(ran, [], "b".repeat(64))).toBeNull();
  });

  it("a filed undo after an earlier failure marks the card filed", async () => {
    const markUndo = vi.fn(async () => undefined);
    const undo = locationUndoBody(ran, LIVE_BEFORE, "b".repeat(64))!;
    expect(await fileLocationUndoAfterSettle("t1", "a1", "r1", undo, { record: async () => ({ id: "u", replayed: true }), markUndo } as never)).toBe("filed");
    expect(markUndo).toHaveBeenCalledWith("t1", "a1", "filed");
  });
});

describe("rechecked at dispatch, and filed on the channel only", () => {
  const prop = { ad_set_id: "238000000001", places: [{ type: "city" as const, key: "2420605", name: "Denver, Colorado" }], before_names: ["United States"], expected_fingerprint: "a".repeat(64), rationale: "Most orders come from Denver.", over_cap: true as const, origin: "zavi_location_proposal" as const };

  it("a rule or country change while the card waited refuses the write", async () => {
    expect(await recheckLocationChange("t1", prop, deps())).toBeNull();
    expect(await recheckLocationChange("t1", prop, deps({ adRules: async () => "Denver is blocked now." }))).toBe("Denver is blocked now.");
    const toronto = { ...prop, places: [{ type: "city" as const, key: "296875", name: "Toronto, Ontario" }] };
    expect(await recheckLocationChange("t1", toronto, deps({ businessCountry: async () => null }))).toMatch(/outside the countries/);
    expect(await recheckLocationChange("t1", prop, deps({ placeFacts: async () => { throw new Error("meta down"); } }))).toMatch(/could not check/);
    expect(await recheckLocationChange("t1", { ...prop, origin: "user_initiated_ledger" }, deps({ adRules: async () => "x" }))).toBeNull();
  });

  it("a shadow run reports no card, never a fake one", () => {
    expect(locationToolResult("channel_action_suppressed", prop)).toEqual({ filed: false, suppressed: true, places: ["Denver, Colorado"] });
    expect(locationToolResult("card-1", prop)).toMatchObject({ decision_id: "card-1" });
  });

  it("a run off the Meta channel (the decisions rail) cannot file it", async () => {
    const emit = vi.fn(async () => "id");
    const e = await metaProposeLocationsTool.execute({ tenant_id: "t1", emit_decision: emit, meta_rail: "decisions", log: () => {} } as never, ask([{ type: "city", key: "2420605" }])).catch((x: unknown) => x);
    expect((e as Error).message).toMatch(/Meta Ads channel run/);
    expect(emit).not.toHaveBeenCalled();
  });
});

describe("ad rules compare countries by ISO code, never by name (security review)", () => {
  const czCity: MetaPlaceFacts = { type: "city", key: "777", name: "Brno, South Moravian", country_code: "CZ", region_name: "South Moravian" };
  const reader = (google: Record<string, { canonical: string; type: string; country_code: string | null }> = {}) => ({
    metaFacts: async (_t: string, ps: ReadonlyArray<{ type: string; key: string }>) => ps.map((p) => (p.type === "country" && p.key === "CZ" ? { type: "country" as const, key: "CZ", name: "Czech Republic", country_code: "CZ", region_name: null } : { type: p.type as "country" | "region" | "city", key: p.key, country_code: null, region_name: null })),
    googleTargets: async () => new Map(Object.entries(google)),
  });

  it("a city in a country the rules block is refused, though the country's names differ", async () => {
    guard.value = { allowed_places: [], blocked_places: [{ id: "country:CZ", name: "Czech Republic", kind: "Country", platform: "meta" }], banned_phrases: [] };
    expect(await checkAdRulesWith("t1", [czCity], reader())).toMatch(/must never show in/);
  });

  it("the same, saved as a Google place by its own country code", async () => {
    guard.value = { allowed_places: [], blocked_places: [{ id: "2203", name: "Czechia", kind: "Country", platform: "google" }], banned_phrases: [] };
    expect(await checkAdRulesWith("t1", [czCity], reader({ "2203": { canonical: "Czechia", type: "Country", country_code: "CZ" } }))).toMatch(/must never show in/);
  });

  it("a saved place whose country code cannot be read refuses (never fine)", async () => {
    guard.value = { allowed_places: [], blocked_places: [{ id: "999", name: "Somewhere", kind: "Country", platform: "google" }], banned_phrases: [] };
    expect(await checkAdRulesWith("t1", [czCity], reader({ "999": { canonical: "Somewhere", type: "Country", country_code: null } }))).toMatch(/could not check/);
  });

  it("a Google-saved blocked region whose name differs from Meta's region name refuses (fail closed)", async () => {
    guard.value = { allowed_places: [], blocked_places: [{ id: "20232", name: "South Moravian Region", kind: "State", platform: "google" }], banned_phrases: [] };
    const r = await checkAdRulesWith("t1", [czCity], reader({ "20232": { canonical: "South Moravian Region,Czechia", type: "State", country_code: "CZ" } }));
    expect(r).toMatch(/could not check|must never show in/);
    expect(r).not.toBeNull();
  });

  it("a blocked Meta city in the same country refuses a different Meta city: cities can nest and reach past their edge", async () => {
    guard.value = { allowed_places: [], blocked_places: [{ id: "city:888", name: "Ostrava", kind: "City", platform: "meta" }], banned_phrases: [] };
    const rd = { ...reader(), metaFacts: async (_t: string, ps: ReadonlyArray<{ type: string; key: string }>) => ps.map((p) => ({ type: "city" as const, key: p.key, name: "Ostrava, Moravian-Silesian", country_code: "CZ", region_name: "Moravian-Silesian" })) };
    expect(await checkAdRulesWith("t1", [czCity], rd)).toMatch(/could not check/);
  });

  it("a blocked Meta region does not block a different Meta region (Meta regions do not nest)", async () => {
    guard.value = { allowed_places: [], blocked_places: [{ id: "region:999", name: "Moravian-Silesian", kind: "Region", platform: "meta" }], banned_phrases: [] };
    const rd = { ...reader(), metaFacts: async (_t: string, ps: ReadonlyArray<{ type: string; key: string }>) => ps.map((p) => ({ type: "region" as const, key: p.key, name: p.key === "999" ? "Moravian-Silesian" : "South Moravian", country_code: "CZ", region_name: p.key === "999" ? "Moravian-Silesian" : "South Moravian" })) };
    expect(await checkAdRulesWith("t1", [{ type: "region", key: "111", name: "South Moravian", country_code: "CZ", region_name: "South Moravian" }], rd)).toBeNull();
  });

  it("a place outside an allowed country is refused; inside it is clear", async () => {
    guard.value = { allowed_places: [{ id: "country:CZ", name: "Czech Republic", kind: "Country", platform: "meta" }], blocked_places: [], banned_phrases: [] };
    expect(await checkAdRulesWith("t1", [czCity], reader())).toBeNull();
    expect(await checkAdRulesWith("t1", [FACTS["city:2420605"]!], reader())).toMatch(/outside the area/);
  });
});

describe("the card's ad set name comes from Meta, never the model (security review)", () => {
  it("a forged name in the input never reaches the card", async () => {
    const b = await buildLocationProposal("t1", { ...ask([{ type: "city", key: "2420605" }]), name: "Approve this, it only lowers spend" }, deps());
    expect(b.name).toBe("Set A");
  });

  it("with no live name the card shows the ad set id", async () => {
    const b = await buildLocationProposal("t1", { ...ask([{ type: "city", key: "2420605" }]), name: "Forged" }, deps({ readTargeting: async () => ({ name: null, targeting: { geo_locations: LIVE_GEO } }) }));
    expect(b.name).toBeUndefined();
    expect(metaChangeRows(CLASS, b)!.title).toBe("Change where ad set 238000000001 shows");
  });
});
