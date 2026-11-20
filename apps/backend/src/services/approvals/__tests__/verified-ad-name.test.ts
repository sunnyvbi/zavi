import { describe, expect, it, vi } from "vitest";
import { adChangeHeadline } from "@zavi/shared";
import { verifiedNameEmit, withVerifiedName } from "../verified-ad-name";

const CUT = { campaign_id: "24362130658", name: "Search A", daily_budget_usd: 10, expected_current_daily_budget_usd: 20, rationale: "r", over_cap: true };

describe("verified_name", () => {
  it("must-catch: the agent's name labels a different campaign than the id; the card names the real one", async () => {
    const read = vi.fn(async (_c: string, _p: Record<string, unknown>, _ids: string[]) => ["Search B"]);
    const body = (await withVerifiedName("t1", "google_ads.update_campaign_budget_review", CUT, read)) as Record<string, unknown>;
    expect(read).toHaveBeenCalledWith("google_ads.update_campaign_budget_review", expect.objectContaining({ campaign_id: "24362130658" }), ["24362130658"]);
    expect(body.verified_name).toBe("Search B");
    expect(adChangeHeadline("google_ads.update_campaign_budget_review", body)).toBe("Cut “Search B” from $20 to $10 a day");
    expect(adChangeHeadline("google_ads.update_campaign_budget_review", body)).not.toContain("Search A");
  });

  it("an unreadable name: the agent's name is shown only beside the id", async () => {
    const body = await withVerifiedName("t1", "google_ads.update_campaign_budget_review", CUT, async () => {
      throw new Error("no connector");
    });
    expect((body as Record<string, unknown>).verified_name).toBeUndefined();
    expect(adChangeHeadline("google_ads.update_campaign_budget_review", body)).toBe("Cut “Search A” (campaign 24362130658) from $20 to $10 a day");
  });

  it("a model-supplied verified_name is dropped, never trusted", async () => {
    const body = await withVerifiedName("t1", "google_ads.update_campaign_budget_review", { ...CUT, verified_name: "Forged" }, async () => []);
    expect((body as Record<string, unknown>).verified_name).toBeUndefined();
  });

  it("Meta ad sets are read by the ad set id; a Google ad-level status is not read (the reader names its ad group)", async () => {
    const read = vi.fn(async (_c: string, _p: Record<string, unknown>, _ids: string[]) => ["Prospecting"]);
    const meta = (await withVerifiedName("t1", "meta_ads.update_ad_set_budget_review", { ad_set_id: "77", daily_budget_usd: 50, expected_current_daily_budget_usd: 40 }, read)) as Record<string, unknown>;
    expect(read.mock.calls[0][2]).toEqual(["77"]);
    expect(meta.verified_name).toBe("Prospecting");
    read.mockClear();
    const ad = await withVerifiedName("t1", "google_ads.set_status_review", { level: "ad", campaign_id: "1", ad_group_id: "2", ad_id: "3", status: "PAUSED" }, read);
    expect(read).not.toHaveBeenCalled();
    expect((ad as Record<string, unknown>).verified_name).toBeUndefined();
  });

  it("must not touch: other classes pass through unchanged and unread", async () => {
    const read = vi.fn(async (_c: string, _p: Record<string, unknown>, _ids: string[]) => ["X"]);
    const kw = { campaign_id: "1", keywords: [] };
    expect(await withVerifiedName("t1", "google_ads.add_keywords", kw, read)).toBe(kw);
    expect(read).not.toHaveBeenCalled();
  });

  it("the emit closure stamps before filing; no closure in, none out", async () => {
    const emit = vi.fn(async (_c: string, _b: unknown) => "d1");
    const wrapped = verifiedNameEmit("t1", emit, async () => ["Real"])!;
    await wrapped("google_ads.update_campaign_budget_review", CUT);
    expect((emit.mock.calls[0][1] as Record<string, unknown>).verified_name).toBe("Real");
    expect(verifiedNameEmit("t1", undefined)).toBeUndefined();
  });
});
