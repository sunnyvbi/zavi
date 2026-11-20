import { beforeEach, expect, it, vi } from "vitest";
const tt = vi.hoisted(() => vi.fn());
vi.mock("../composio-read", () => ({ tt }));
import { readTiktokLocationNames, verifyTiktokLocations } from "../locations";
import type { OwnedComposioAccount } from "@/services/connectors/composio/api";
const account = {tenant_id: "tenant", connected_account_id: "account"} as OwnedComposioAccount;
const tag = (id: string, name: string, status: string, parent: string | null = null) => ({
  targeting_type: "GEO", name, status_info: {status},
  geo: {geo_id: id, geo_type: parent ? "CITY" : "COUNTRY", region_code: "US", parent_id: parent},
});
beforeEach(() => { tt.mockReset(); });
it("reads the removed location's name even when it is disabled, without relaxing targeting verification", async () => {
  tt.mockResolvedValue({targeting_tag_list: [tag("10", "Austin", "DISABLED", "20")], parent_tags: [tag("20", "United States", "ENABLED")]});
  expect(await readTiktokLocationNames(account, "123", ["10", "10"])).toEqual({"10": "Austin, United States"});
  expect(tt).toHaveBeenCalledWith(account, "/tool/targeting/info/", expect.objectContaining({advertiser_id: "123", targeting_ids: ["10"]}));
  await expect(verifyTiktokLocations(account, "123", ["10"])).rejects.toMatchObject({code: "tiktok_ads_location_not_allowed"});
});
it("does not invent names for missing IDs or accept unrelated tags", async () => {
  tt.mockResolvedValue({targeting_tag_list: [tag("20", "United States", "ENABLED")]});
  expect(await readTiktokLocationNames(account, "123", ["10"])).toEqual({});
  expect(await readTiktokLocationNames(account, "123", [])).toEqual({});
  expect(tt).toHaveBeenCalledTimes(1);
});
it("a failed provider read cannot be mistaken for an empty location list", async () => {
  tt.mockRejectedValue(new Error("unavailable"));
  await expect(readTiktokLocationNames(account, "123", ["10"])).rejects.toThrow("unavailable");
});
