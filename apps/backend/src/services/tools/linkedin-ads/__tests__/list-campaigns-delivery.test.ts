import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolSpec } from "@/services/tools/types";

const m = vi.hoisted(() => ({ list: vi.fn(), ads: vi.fn() }));
vi.mock("@/services/tools/linkedin-ads/_wallet", async (orig) => ({ ...(await orig<Record<string, unknown>>()), linkedinWalletGroups: async () => [], linkedinAccountAccess: async () => ({ kind: "own" }) }));
vi.mock("@/services/connectors/linkedin-ads/client", () => ({ listLinkedInCampaigns: m.list, readLinkedInAdStates: m.ads }));

import { linkedinAdsListCampaignsTool } from "../list_campaigns";

const campaign = (id: string, status: string) => ({ id, name: `C${id}`, status, objective: "WEBSITE_VISITS", budget: { kind: "daily", amount: 10 } });
const ad = (campaign_id: string, over: Record<string, unknown> = {}) => ({ campaign_id, intended_status: "ACTIVE", is_serving: true, hold_reasons: [], review_status: "APPROVED", ...over });
const run = async () =>
  (await linkedinAdsListCampaignsTool.execute({ tenant_id: "t" } as Parameters<ToolSpec["execute"]>[0], { account_id: "42" })) as {
    count: number;
    campaigns: Array<{ id: string; status: string; delivery: string; delivery_note: string }>;
  };
const byId = async () => Object.fromEntries((await run()).campaigns.map((c) => [c.id, c]));

describe("linkedin_ads_list_campaigns delivery", () => {
  beforeEach(() => {
    m.list.mockReset();
    m.ads.mockReset();
  });
  it("must catch: two ACTIVE $10/day campaigns are told apart, the one under review with $0 spent is not spending", async () => {
    m.list.mockResolvedValue([campaign("1", "ACTIVE"), campaign("2", "ACTIVE"), campaign("3", "PAUSED")]);
    m.ads.mockResolvedValue([ad("1"), ad("2", { is_serving: false, hold_reasons: ["UNDER_REVIEW"], review_status: "PENDING" })]);
    const rows = await byId();
    expect(rows["1"].delivery).toBe("serving");
    expect(rows["2"]).toMatchObject({ status: "ACTIVE", delivery: "in_review" });
    expect(rows["2"].delivery_note).toContain("never that it is spending");
    expect(rows["3"].delivery).toBe("not_on");
    expect(m.ads).toHaveBeenCalledTimes(1);
    expect(m.ads).toHaveBeenCalledWith("t", "42", ["1", "2"]);
  });
  it("one serving ad beside one in review still counts as delivering", async () => {
    m.list.mockResolvedValue([campaign("1", "ACTIVE")]);
    m.ads.mockResolvedValue([ad("1"), ad("1", { is_serving: false, review_status: "PENDING" })]);
    expect((await byId())["1"].delivery).toBe("serving");
  });
  it("a failed ad read keeps the campaign list and claims nothing: every ACTIVE row is unread, not spending", async () => {
    m.list.mockResolvedValue([campaign("1", "ACTIVE"), campaign("3", "PAUSED")]);
    m.ads.mockRejectedValue(new Error("rate limited"));
    const out = await run();
    expect(out.count).toBe(2);
    const [active, paused] = out.campaigns;
    expect(active.delivery).toBe("unread");
    expect(active.delivery_note).toContain("only if linkedin_ads_read_analytics shows spend");
    expect(paused.delivery).toBe("not_on");
  });
  it("an ACTIVE campaign LinkedIn returned no ads for cannot be delivering", async () => {
    m.list.mockResolvedValue([campaign("1", "ACTIVE")]);
    m.ads.mockResolvedValue([]);
    expect((await byId())["1"].delivery).toBe("no_ads");
  });
  it("spends no LinkedIn read on ad states when nothing is switched on", async () => {
    m.list.mockResolvedValue([campaign("3", "PAUSED")]);
    await run();
    expect(m.ads).not.toHaveBeenCalled();
  });
});
