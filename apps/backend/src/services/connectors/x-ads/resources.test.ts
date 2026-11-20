import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  assertXLineChanges,
  assertXWriteAccess,
  listXResources,
  readXAccess,
  updateXLineItem,
  type XLineItem,
} from "./resources";
import { xCampaignStats } from "./client";

const token = { key: "test-token", secret: "test-secret" };
const line: XLineItem = {
  id: "li1",
  campaign_id: "c1",
  objective: "WEBSITE_CLICKS",
  product_type: "PROMOTED_TWEETS",
  placements: ["ALL_ON_TWITTER"],
  entity_status: "PAUSED",
  start_time: "2099-01-01T00:00:00Z",
  end_time: "2099-02-01T00:00:00Z",
  bid_strategy: "AUTO",
  bid_amount_local_micro: null,
  daily_budget_amount_local_micro: 10000000,
  total_budget_amount_local_micro: 100000000,
  currency: "USD",
  updated_at: "2026-10-09T00:00:00Z",
};
const reply = (data: unknown) =>
  new Response(JSON.stringify(data), { status: 200 });
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  process.env.X_ADS_CONSUMER_KEY = "test";
  process.env.X_ADS_CONSUMER_SECRET = "test";
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("X Ads official API contract", () => {
  it("distinguishes analyst access from campaign management and never claims app write approval", async () => {
    fetchMock.mockImplementation(async () =>
      reply({ data: { user_id: "1", permissions: ["CAMPAIGN_ANALYST"] } }),
    );
    expect(await readXAccess(token, "a1")).toMatchObject({
      can_read_campaigns: true,
      can_manage_campaigns: false,
      app_write_access: "unverified",
    });
    await expect(assertXWriteAccess(token, "a1")).rejects.toMatchObject({
      code: "x_ads_permission_denied",
    });
    expect(new URL(fetchMock.mock.calls[0][0]).pathname).toBe(
      "/12/accounts/a1/authenticated_user_access",
    );
  });
  it("requires a valid permission response", async () => {
    fetchMock.mockResolvedValue(reply({ data: { user_id: "1" } }));
    await expect(assertXWriteAccess(token, "a1")).rejects.toThrow();
  });
  it("serializes bids and budgets once in micro-currency units", async () => {
    fetchMock.mockResolvedValue(reply({ data: line }));
    await updateXLineItem(token, "a1", "li1", {
      bid_strategy: "TARGET",
      bid_amount: 0.75,
      daily_budget: 12.5,
      end_time: "2099-03-01T00:00:00Z",
    });
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe("/12/accounts/a1/line_items/li1");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      bid_strategy: "TARGET",
      bid_amount_local_micro: "750000",
      daily_budget_amount_local_micro: "12500000",
      end_time: "2099-03-01T00:00:00Z",
    });
    expect(fetchMock.mock.calls[0][1].method).toBe("PUT");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toMatch(/^OAuth /);
  });
  it("refuses documented objective/bid restrictions and invalid schedule or caps", () => {
    expect(() =>
      assertXLineChanges(
        { ...line, objective: "REACH" },
        { bid_strategy: "MAX", bid_amount: 1 },
      ),
    ).toThrow(/not documented/);
    expect(() =>
      assertXLineChanges(
        { ...line, objective: "FOLLOWERS" },
        { bid_strategy: "TARGET", bid_amount: 1 },
      ),
    ).toThrow(/not documented/);
    expect(() => assertXLineChanges(line, { bid_strategy: "MAX" })).toThrow(
      /positive/,
    );
    expect(() =>
      assertXLineChanges(line, { end_time: "2098-01-01T00:00:00Z" }),
    ).toThrow(/after start/);
    expect(() => assertXLineChanges(line, { daily_budget: 101 })).toThrow(
      /total budget/,
    );
  });
  it("follows targeting pagination and refuses repeated cursors", async () => {
    fetchMock
      .mockResolvedValueOnce(
        reply({ data: [{ id: "t1" }], next_cursor: "next" }),
      )
      .mockResolvedValueOnce(reply({ data: [{ id: "t2" }] }));
    expect(
      await listXResources(token, "a1", "targeting_criteria", {
        line_item_ids: "li1",
      }),
    ).toEqual([{ id: "t1" }, { id: "t2" }]);
    expect(new URL(fetchMock.mock.calls[1][0]).searchParams.get("cursor")).toBe(
      "next",
    );
    fetchMock.mockImplementation(async () =>
      reply({ data: [{ id: "t1" }], next_cursor: "repeated" }),
    );
    await expect(
      listXResources(token, "a1", "line_items"),
    ).rejects.toMatchObject({ code: "x_ads_inventory_incomplete" });
  });
  it("tracks omitted metrics and treats a returned zero link-click count as zero", async () => {
    fetchMock.mockResolvedValue(
      reply({
        data: [
          {
            id: "c1",
            id_data: [
              {
                metrics: {
                  billed_charge_local_micro: [0],
                  impressions: [0],
                  url_clicks: [0],
                  clicks: [20],
                },
              },
            ],
          },
        ],
      }),
    );
    const stats = await xCampaignStats(
      token,
      "a1",
      ["c1"],
      "2026-10-01",
      "2026-10-07",
    );
    expect(stats.get("c1")?.clicks).toBe(0);
    expect(stats.missing.get("c1")?.has("conversions")).toBe(true);
    expect(stats.missing.get("c1")?.has("spend")).toBe(false);
  });
});
