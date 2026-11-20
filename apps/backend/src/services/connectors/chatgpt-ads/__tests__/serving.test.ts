vi.mock("../http",()=>({chatgptAdsGet:vi.fn()}));
import { afterEach, expect, it, vi } from "vitest";
import { servingReady,assertServingReady } from "../serving";
afterEach(() => { vi.unstubAllEnvs(); });
it("requires explicit operator approval, approved brand, and the reviewed advertiser website", () => {
  vi.stubEnv("CHATGPT_ADS_SERVING_APPROVED", "false"); vi.stubEnv("CHATGPT_ADS_ADVERTISER_WEBSITE", "https://zavi.example");
  const account = { status: "active", review: { status: "approved" }, url: "https://zavi.example" };
  expect(servingReady(account)).toBe(false);
  vi.stubEnv("CHATGPT_ADS_SERVING_APPROVED", "true");
  expect(servingReady(account)).toBe(true);
  expect(servingReady({ ...account, review: { status: "in_review" } })).toBe(false);
  expect(servingReady({ ...account, url: "https://other.example" })).toBe(false);
  expect(servingReady({ ...account, status: "suspended" })).toBe(false);
  vi.stubEnv("CHATGPT_ADS_ADVERTISER_WEBSITE", ""); expect(servingReady(account)).toBe(false);
});

it("uses a customer's own advertiser approval without requiring Zavi's website approval",async()=>{
 const {chatgptAdsGet}=await import("../http");vi.stubEnv("CHATGPT_ADS_SERVING_APPROVED","false");
 vi.mocked(chatgptAdsGet).mockResolvedValue({status:"active",review:{status:"approved"},url:"https://customer.example"});
 await expect(assertServingReady("customer-key","provider")).resolves.toBeUndefined();
 await expect(assertServingReady("shared-key","wallet")).rejects.toThrow();
 vi.mocked(chatgptAdsGet).mockResolvedValue({status:"suspended",review:{status:"approved"}});await expect(assertServingReady("customer-key","provider")).rejects.toThrow();
});
