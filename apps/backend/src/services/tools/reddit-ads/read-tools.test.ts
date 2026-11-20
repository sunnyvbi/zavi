import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ owned: vi.fn(), pages: vi.fn(), get: vi.fn(), list: vi.fn() }));
vi.mock("@/services/connectors/reddit-ads/adapter", () => ({ ownedAccount: mocks.owned, pages: mocks.pages, getObject: mocks.get, listObjects: mocks.list, endpoint: (path: string, id: string, suffix = "") => `https://ads-api.reddit.com/api/v3/${path}/${id}${suffix}` }));
import { redditReadTools } from "./read-tools";
import type { ToolSpec } from "@/services/tools/types";
const ctx = { tenant_id: "tenant" } as Parameters<ToolSpec["execute"]>[0];
const tool = (name: string) => redditReadTools.find((t) => t.name === name)!;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.owned.mockResolvedValue({ account: { tenant_id: "tenant" } });
  mocks.pages.mockResolvedValue([]);
  mocks.get.mockResolvedValue({ id: "c1" });
  mocks.list.mockResolvedValue([{ id: "c1" }, { id: "c2" }]);
});
describe("Reddit read-only tools", () => {
  it("exposes only reads", () => {
    expect(redditReadTools.map((t) => [t.name, t.effect])).toEqual([
      ["reddit_ads_check_readiness", "read"],
      ["reddit_ads_read_performance", "read"],
      ["reddit_ads_read_objects", "read"],
      ["reddit_ads_list_targeting", "read"],
    ]);
  });
  it("proves account ownership before any targeting or object read", async () => {
    await tool("reddit_ads_list_targeting").execute(ctx, { ad_account_id: "account", kind: "interests" });
    expect(mocks.owned).toHaveBeenCalledWith("tenant", "account");
    mocks.owned.mockRejectedValueOnce(new Error("not owned"));
    await expect(tool("reddit_ads_read_objects").execute(ctx, { ad_account_id: "other", level: "campaign" })).rejects.toThrow("not owned");
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it("sends only catalogue-supported filters for each targeting resource", async () => {
    const targeting = tool("reddit_ads_list_targeting");
    await targeting.execute(ctx, { ad_account_id: "account", kind: "geolocations", country: "US", cities_search: "Boston" });
    expect(mocks.pages).toHaveBeenLastCalledWith({ tenant_id: "tenant" }, "LIST_GEOLOCATIONS", { country: "US", cities_search: "Boston" }, "https://ads-api.reddit.com/api/v3/targeting/geolocations");
    await targeting.execute(ctx, { ad_account_id: "account", kind: "communities", names: ["cars", "travel"] });
    expect(mocks.pages).toHaveBeenLastCalledWith({ tenant_id: "tenant" }, "LIST_COMMUNITIES", { names: "cars,travel" }, "https://ads-api.reddit.com/api/v3/targeting/communities");
    await expect(targeting.execute(ctx, { ad_account_id: "account", kind: "interests", country: "US" })).rejects.toThrow();
  });
  it("reads one object or the whole level", async () => {
    expect(await tool("reddit_ads_read_objects").execute(ctx, { ad_account_id: "account", level: "campaign", object_id: "c1" })).toEqual({ id: "c1" });
    expect(mocks.get).toHaveBeenCalledWith({ tenant_id: "tenant" }, "account", "campaign", "c1");
    expect(await tool("reddit_ads_read_objects").execute(ctx, { ad_account_id: "account", level: "ad" })).toHaveLength(2);
    expect(mocks.list).toHaveBeenCalledWith({ tenant_id: "tenant" }, "account", "ad");
  });
});
