import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ tt: vi.fn() }));
vi.mock("./composio-read", () => ({ tt: m.tt }));
import { advancedGroupSchema, advancedGroupValues, advancedGroupMatches, describeDayparting, readCampaignAudiences, readCampaignInterests, verifyAdvancedGroup } from "./campaign-advanced";
import type { OwnedComposioAccount } from "@/services/connectors/composio/api";
const account = {} as OwnedComposioAccount;
beforeEach(() => m.tt.mockReset());
it("scopes the audience picker to the advertiser and follows pages", async () => {
  m.tt.mockResolvedValueOnce({ list: [{ custom_audience_id: "11", name: "Customers", is_valid: true }, { custom_audience_id: "12", name: "Expired", is_valid: false }], page_info: { total_page: 2 } })
    .mockResolvedValueOnce({ list: [{ custom_audience_id: "13", name: "Reservation", is_valid: true, audience_sub_type: "REACH_FREQUENCY" }, { custom_audience_id: "14", name: "Visitors", is_valid: true }], page_info: { total_page: 2 } });
  expect(await readCampaignAudiences(account, "111")).toEqual({ options: [{ id: "11", name: "Customers" }, { id: "14", name: "Visitors" }], truncated: false });
  expect(m.tt.mock.calls[1][1]).toContain("advertiser_id=111&page=2");
});
it("refuses unreadable catalog responses instead of treating them as a broad audience", async () => {
  m.tt.mockResolvedValue({ list: [{ custom_audience_id: "11", name: "Unknown" }] });
  await expect(readCampaignAudiences(account, "111")).rejects.toMatchObject({ code: "tiktok_ads_targeting_unavailable" });
});
it("filters interest choices by TikTok placement", async () => {
  m.tt.mockResolvedValue({ interest_categories: [{ interest_category_id: "1", interest_category_name: "Sport", placements: [] }, { interest_category_id: "2", interest_category_name: "Other", placements: ["PLACEMENT_PANGLE"] }] });
  expect(await readCampaignInterests(account, "111")).toEqual([{ id: "1", name: "Sport" }]);
});
it("checks one audience catalog for both inclusion and exclusion and rejects missing IDs", async () => {
  m.tt.mockResolvedValue({ list: [{ custom_audience_id: "11", name: "Customers", is_valid: true }] });
  await expect(verifyAdvancedGroup(account, "111", { audience_ids: ["11"], excluded_audience_ids: ["12"] })).rejects.toThrow("unavailable");
  expect(m.tt).toHaveBeenCalledTimes(1);
  expect(new URL(m.tt.mock.calls[0][1], "https://example.com").searchParams.get("custom_audience_ids")).toBe('["11","12"]');
});
it("does not read catalogs for unrelated edits or clearing lists", async () => {
  await verifyAdvancedGroup(account, "111", {});
  await verifyAdvancedGroup(account, "111", { audience_ids: [], interest_category_ids: [] });
  expect(m.tt).not.toHaveBeenCalled();
});
it("rejects overlap with an unchanged excluded audience", async () => {
  await expect(verifyAdvancedGroup(account, "111", { audience_ids: ["11"] }, { excluded_audience_ids: ["11"] })).rejects.toThrow("both included and excluded");
});
it("requires a positive CPC bid only for the reviewed custom strategy", async () => {
  await expect(verifyAdvancedGroup(account, "111", { bid_type: "BID_TYPE_CUSTOM" })).rejects.toThrow("positive CPC");
  await expect(verifyAdvancedGroup(account, "111", { bid_price: 1 }, { bid_type: "BID_TYPE_NO_BID" })).rejects.toThrow("only");
  await expect(verifyAdvancedGroup(account, "111", { bid_type: "BID_TYPE_CUSTOM", bid_price: 1 })).resolves.toBeUndefined();
});
it("rejects generic fields and malformed half-hour schedules", () => {
  expect(advancedGroupSchema.safeParse({ budget: 100 }).success).toBe(false);
  expect(advancedGroupSchema.safeParse({ dayparting: "1".repeat(335) }).success).toBe(false);
  expect(advancedGroupSchema.safeParse({ operating_systems: ["invented"] }).success).toBe(false);
});
it("normalizes membership without changing daypart order and checks provider readback", () => {
  const value = advancedGroupValues({ audience_ids: ["2", "1", "2"], dayparting: "0".repeat(336) });
  expect(value).toEqual({ audience_ids: ["1", "2"], dayparting: "1".repeat(336) });
  expect(advancedGroupMatches({ audience_ids: ["2", "1"], dayparting: null }, value)).toBe(true);
  expect(advancedGroupMatches({ audience_ids: ["1"], dayparting: null }, value)).toBe(false);
});
it("renders a reviewable weekly schedule instead of 336 bits", () => {
  expect(describeDayparting("0".repeat(336))).toBe("Every day, all day");
  const schedule = "0".repeat(18) + "1".repeat(16) + "0".repeat(302);
  expect(describeDayparting(schedule)).toBe("Mon: 09:00–17:00; Tue: off; Wed: off; Thu: off; Fri: off; Sat: off; Sun: off");
});
