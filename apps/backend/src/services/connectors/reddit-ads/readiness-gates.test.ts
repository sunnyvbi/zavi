import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ owned: vi.fn(), pages: vi.fn(), tool: vi.fn() }));
vi.mock("./adapter", async (original) => ({ ...await original<typeof import("./adapter")>(), ownedAccount: mocks.owned, pages: mocks.pages, tool: mocks.tool }));
import { assertReady } from "./readiness-gates";
beforeEach(() => { vi.clearAllMocks(); mocks.owned.mockResolvedValue({ account: {}, details: { currency: "USD", time_zone_id: "America/Los_Angeles", admin_approval: "VALID" } }); mocks.tool.mockResolvedValue({ data: {} }); });
describe("Reddit execution readiness gates", () => {
  it("passes an owned pixel and blocks missing permissions and foreign pixels", async () => {
    mocks.pages.mockResolvedValue([{ id: "pixel" }]);
    await expect(assertReady("tenant", "account", "pixel")).resolves.toMatchObject({ details: { currency: "USD" } });
    await expect(assertReady("tenant", "account", "foreign")).rejects.toMatchObject({ code: "reddit_ads_pixel_not_owned" });
    mocks.pages.mockRejectedValue(new Error("adsread permission missing"));
    await expect(assertReady("tenant", "account", "pixel")).rejects.toThrow("permission missing");
  });
  it("blocks unsupported currency and unapproved accounts before any tracking read", async () => {
    mocks.owned.mockResolvedValueOnce({ account: {}, details: { currency: "EUR", admin_approval: "VALID" } });
    await expect(assertReady("tenant", "account", "pixel")).rejects.toMatchObject({ code: "reddit_ads_currency_unsupported" });
    mocks.owned.mockResolvedValueOnce({ account: {}, details: { currency: "USD", suspension_reason: "policy" } });
    await expect(assertReady("tenant", "account", "pixel")).rejects.toMatchObject({ code: "reddit_ads_account_not_ready" });
    expect(mocks.pages).not.toHaveBeenCalled();
  });
});
