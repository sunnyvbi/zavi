import { beforeEach, expect, it, vi } from "vitest";
const get = vi.hoisted(() => vi.fn());
vi.mock("../http", () => ({ chatgptAdsGet: get }));
import { purchaseWindow, readOwnedPurchaseReturn } from "../purchases";
beforeEach(() => { get.mockReset(); });
it("uses complete local dates across daylight-saving boundaries", () => {
  expect(purchaseWindow(7, "America/Los_Angeles", new Date("2026-03-10T02:00:00Z"))).toEqual({ from: "2026-03-02", to: "2026-03-08", timezone: "America/Los_Angeles", days: 7 });
});
it("weights workspace ROAS by spend instead of averaging campaign ratios", async () => {
  get.mockImplementation(async (_key, path) => ({ data: [{ campaign_id: path.includes("c1") ? "c1" : "c2", spend: path.includes("c1") ? 100 : 10, order_created_attributed_sales: path.includes("c1") ? 200 : 100 }] }));
  const result = await readOwnedPurchaseReturn("key", ["c1", "c2"], 7, "UTC");
  expect(result?.roas).toBeCloseTo(300 / 110);
  expect(get.mock.calls.every(([, path]) => path.startsWith("/campaigns/"))).toBe(true);
});
it("does not substitute zero for missing purchase values", async () => {
  get.mockResolvedValue({ data: [{ campaign_id: "c1", spend: 100, order_created_attributed_sales: null }] });
  expect((await readOwnedPurchaseReturn("key", ["c1"], 7, "UTC"))?.roas).toBeNull();
});
it("rejects a foreign or incomplete purchase response", async () => {
  get.mockResolvedValue({ data: [{ campaign_id: "other", spend: 100, order_created_attributed_sales: 200 }] });
  await expect(readOwnedPurchaseReturn("key", ["c1"], 7, "UTC")).rejects.toThrow("incomplete");
});
