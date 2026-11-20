import { describe, expect, it, vi, beforeEach } from "vitest";

const fbGet = vi.fn();
vi.mock("@/services/tools/meta-ads/_client", () => ({
  metaAdsCreds: async () => ({ ad_account_id: "act_1" }),
  fbGet: (...a: unknown[]) => fbGet(...a),
}));
const gadsCustomerId = vi.fn();
const gadsStoredCustomerId = vi.fn();
vi.mock("@/services/tools/google-ads/_client", () => ({
  gadsCustomerId: (...a: unknown[]) => gadsCustomerId(...a),
  gadsStoredCustomerId: (...a: unknown[]) => gadsStoredCustomerId(...a),
  gadsSearch: vi.fn(),
}));

import { _resetAccountZones, accountTodays, dateInZone, metaAccountZone, rememberAccountZone, wholeDaysWindow, ZONE_TTL_MS } from "../account-zone";

beforeEach(() => {
  vi.clearAllMocks();
  _resetAccountZones();
  gadsCustomerId.mockRejectedValue(Object.assign(new Error("no"), { code: "google_ads_not_connected" }));
  gadsStoredCustomerId.mockRejectedValue(new Error("no"));
});

describe("account clocks", () => {
  it("the same instant is a different day on each side of UTC", () => {
    const at = new Date("2026-10-03T02:00:00Z");
    expect(dateInZone(at, "America/Los_Angeles")).toBe("2026-10-02");
    expect(dateInZone(at, "UTC")).toBe("2026-10-03");
    expect(dateInZone(new Date("2026-10-02T20:00:00Z"), "Australia/Sydney")).toBe("2026-10-03");
  });

  it("a window of whole days ends yesterday on the account's clock, across a month end", () => {
    expect(wholeDaysWindow("2026-10-02", 3)).toEqual({ since: "2026-09-29", until: "2026-10-01" });
    expect(wholeDaysWindow("2026-10-02", 7)).toEqual({ since: "2026-09-25", until: "2026-10-01" });
  });

  it("Meta's zone is read once a day per account", async () => {
    fbGet.mockResolvedValue({ timezone_name: "America/New_York" });
    const now = new Date("2026-10-03T02:00:00Z");
    expect(await metaAccountZone("t1", "act_1", now)).toBe("America/New_York");
    expect(await metaAccountZone("t1", "act_1", new Date(now.getTime() + 3_600_000))).toBe("America/New_York");
    expect(fbGet).toHaveBeenCalledTimes(1);
    await metaAccountZone("t1", "act_1", new Date(now.getTime() + ZONE_TTL_MS));
    expect(fbGet).toHaveBeenCalledTimes(2);
  });

  it("accountTodays without fetch uses only zones already read; an unread or unconnected platform is left to UTC", async () => {
    fbGet.mockResolvedValue({ timezone_name: "America/Los_Angeles" });
    const now = new Date("2026-10-03T02:00:00Z");
    expect(await accountTodays("t1", ["meta", "google"], now, { fetch: false })).toEqual({});
    expect(fbGet).not.toHaveBeenCalled();
    expect(await accountTodays("t1", ["meta", "google"], now, { fetch: true })).toEqual({ meta: "2026-10-02" });
    expect(await accountTodays("t1", ["meta"], now, { fetch: false })).toEqual({ meta: "2026-10-02" });
  });

  it("without fetch, Google's id comes from the vault and the OAuth-refreshing credential read never runs", async () => {
    const now = new Date("2026-10-03T02:00:00Z");
    gadsStoredCustomerId.mockResolvedValue("1234567890");
    rememberAccountZone("t1", "google", "1234567890", "Asia/Tokyo", now);
    expect(await accountTodays("t1", ["google"], now, { fetch: false })).toEqual({ google: "2026-10-03" });
    expect(gadsCustomerId).not.toHaveBeenCalled();
  });

  it("a zone Meta does not report never becomes a date", async () => {
    fbGet.mockResolvedValue({});
    const now = new Date("2026-10-03T02:00:00Z");
    await expect(metaAccountZone("t1", "act_1", now)).rejects.toThrow(/time zone/);
    expect(await accountTodays("t1", ["meta"], now, { fetch: true })).toEqual({});
  });
});
