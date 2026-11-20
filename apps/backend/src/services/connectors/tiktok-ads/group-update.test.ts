import { describe, expect, it } from "vitest";
import { fullGroupUpdate, projectGroupReadValue } from "./group-update";

const base = { adgroup_name: "Group", pacing: "PACING_MODE_SMOOTH", languages: ["en"], location_ids: ["840"], budget: 30, budget_mode: "BUDGET_MODE_DYNAMIC_DAILY_BUDGET", billing_event: "CPC", bid_type: "BID_TYPE_NO_BID", bid_price: 0 };
describe("the official full-replacement ad-group update contract", () => {
  it("preserves unchanged targeting and pacing while excluding context and read-only properties", () => {
    expect(fullGroupUpdate({ ...base, provider_only: "secret", operation_status: "ENABLE" }, { adgroup_name: "New" })).toEqual({ adgroup_name: "New", pacing: "PACING_MODE_SMOOTH", languages: ["en"], location_ids: ["840"], budget: 30, bid_type: "BID_TYPE_NO_BID" });
  });
  it("strips keyword review metadata but retains the actual keyword configuration", () => {
    const keyword = { keyword: "shoes", match_type: "PHRASE_WORD", keyword_bid_type: "FOLLOW_ADGROUP", audit_status: "APPROVED", reason: "metadata" };
    const request = fullGroupUpdate({ ...base, search_keywords: [keyword] }, {});
    expect(request.search_keywords).toEqual([{ keyword: "shoes", match_type: "PHRASE_WORD", keyword_bid_type: "FOLLOW_ADGROUP" }]);
    expect(projectGroupReadValue("search_keywords", [{ ...keyword, audit_status: "REVIEWING" }])).toEqual(request.search_keywords);
  });
  it("requires pacing outside CBO and omits CBO-owned budget, bid strategy and pacing", () => {
    expect(() => fullGroupUpdate({ ...base, pacing: null }, {})).toThrow("required pacing");
    const request = fullGroupUpdate(base, {}, { budget_optimize_on: true });
    expect(request).not.toHaveProperty("budget");
    expect(request).not.toHaveProperty("bid_type");
    expect(request).not.toHaveProperty("pacing");
    expect(request).not.toHaveProperty("bid_price");
  });
  it("retains unchanged conditional schedule companions and rejects an incomplete schedule", () => {
    const scheduled = { ...base, schedule_type: "SCHEDULE_START_END", schedule_start_time: "2027-01-01 09:00:00", schedule_end_time: "2027-01-02 09:00:00" };
    expect(fullGroupUpdate(scheduled, { schedule_end_time: "2027-01-03 09:00:00" })).toMatchObject({ schedule_type: "SCHEDULE_START_END", schedule_start_time: scheduled.schedule_start_time, schedule_end_time: "2027-01-03 09:00:00" });
    expect(() => fullGroupUpdate({ ...scheduled, schedule_end_time: null }, { adgroup_name: "New" })).toThrow("required schedule end time");
  });
  it("refuses missing conditional funnel and bid settings rather than resetting them", () => {
    expect(() => fullGroupUpdate({ ...base, deep_funnel_optimization_status: "ON" }, {})).toThrow("required deep funnel");
    expect(() => fullGroupUpdate({ ...base, bid_type: "BID_TYPE_CUSTOM", bid_price: null }, {})).toThrow("required bid price");
    expect(() => fullGroupUpdate({ ...base, secondary_optimization_event: "PURCHASE" }, {})).toThrow("required deep bid type");
  });
  it("refuses unsafe saved audiences and deprecated automatic targeting", () => {
    for (const setting of [{ saved_audience_id: "123" }, { audience_rule: { opaque: "rule" } }, { auto_targeting_enabled: true }, { targeting_expansion: { expansion_enabled: true, expansion_types: ["AGE"] } }, { brand_safety_type: "THIRD_PARTY" }]) expect(() => fullGroupUpdate({ ...base, ...setting }, { adgroup_name: "New" })).toThrow("cannot safely preserve");
  });
  it("omits the unchanged default brand safety while preserving active inventory filters", () => {
    expect(fullGroupUpdate({ ...base, brand_safety_type: "NO_BRAND_SAFETY" }, { adgroup_name: "New" })).not.toHaveProperty("brand_safety_type");
    expect(fullGroupUpdate({ ...base, brand_safety_type: "STANDARD_INVENTORY" }, { adgroup_name: "New" })).toHaveProperty("brand_safety_type", "STANDARD_INVENTORY");
  });
  it("accepts unrestricted or single operating systems, never two", () => {
    expect(fullGroupUpdate(base, { operating_systems: [] }).operating_systems).toEqual([]);
    expect(fullGroupUpdate(base, { operating_systems: ["IOS"] }).operating_systems).toEqual(["IOS"]);
    expect(() => fullGroupUpdate(base, { operating_systems: ["IOS", "ANDROID"] })).toThrow("accepts one");
  });
});
