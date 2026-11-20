import { beforeEach, describe, expect, it, vi } from "vitest";

const { fbGet, metaAdsCreds } = vi.hoisted(() => ({ fbGet: vi.fn(), metaAdsCreds: vi.fn() }));
vi.mock("../_client", () => ({ fbGet, metaAdsCreds }));
import { campaignThumbnailUrls, readCampaignThumbnails } from "../campaign-thumbnails";

const media = (account_id?: string) => ({ account_id, ads: { data: [{ effective_status: "ACTIVE", creative: { thumbnail_url: "https://example.com/owned.jpg" } }] } });

beforeEach(() => {
  fbGet.mockReset();
  metaAdsCreds.mockReset();
  metaAdsCreds.mockResolvedValue({ ad_account_id: "act_100", access_token: "token" });
});

describe("Meta campaign thumbnail ownership", () => {
  it("returns media only for the selected account, failing closed for missing ownership", () => {
    expect(campaignThumbnailUrls({ "1": media("100"), "2": media("200"), "3": media() }, ["1", "2", "3"], "act_100")).toEqual({ "1": ["https://example.com/owned.jpg"], "2": [], "3": [] });
  });
  it("checks ownership even when the token can read another account's campaign", async () => {
    fbGet.mockResolvedValue({ "2": media("200") });
    expect(await readCampaignThumbnails("tenant-multi-account", ["2"])).toEqual({ "2": [] });
    expect(fbGet).toHaveBeenCalledWith("tenant-multi-account", "", expect.objectContaining({ fields: expect.stringContaining("account_id") }));
  });
  it("does not reuse cached media or an in-flight read after changing accounts", async () => {
    let finish: ((value: unknown) => void) | undefined;
    fbGet.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = readCampaignThumbnails("tenant-switch", ["1"]);
    await vi.waitFor(() => expect(fbGet).toHaveBeenCalledTimes(1));
    metaAdsCreds.mockResolvedValue({ ad_account_id: "act_200", access_token: "token" });
    fbGet.mockResolvedValue({ "1": media("100") });
    expect(await readCampaignThumbnails("tenant-switch", ["1"])).toEqual({ "1": [] });
    if (!finish) throw new Error("Read not started");
    finish({ "1": media("100") });
    expect(await first).toEqual({ "1": ["https://example.com/owned.jpg"] });
    expect(await readCampaignThumbnails("tenant-switch", ["1"])).toEqual({ "1": [] });
  });
});
