import { describe, expect, it, vi } from "vitest";
vi.mock("@/services/company/facts", () => ({ getCompanyFacts: vi.fn() }));
vi.mock("@/services/connectors/chatgpt-ads/http", () => ({ chatgptAdsGet: vi.fn() }));
vi.mock("@/services/connectors/chatgpt-ads/key-provider", () => ({ getChatgptAdsApiKey: vi.fn() }));
vi.mock("../wallet", () => ({ fundingEnabled: () => false }));
vi.mock("../funding-context", () => ({ readChatgptFundingContext: async () => ({ status: "unavailable" }) }));
import { accountReadiness, chatgptAdsRunContext } from "../context";

describe("managed account readiness", () => {
  it("active does not imply brand approved and hides shared account identity", () => {
    const result = accountReadiness({ id: "private", name: "Another brand", status: "active", url: "https://other.example", review: { status: "pending" } }, "https://client.example");
    expect(result.brand_review).toBe("pending");
    expect(result.advertiser_website_matches).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/private|Another brand|other.example/);
  });
  it("normalizes www while retaining the operator approval boundary", () => {
    const result = accountReadiness({ url: "https://www.client.example", review: { status: "approved" } }, "https://client.example/");
    expect(result.advertiser_website_matches).toBe(true);
    expect(result.launch_approval).toBe("requires_operator_review");
  });
  it("missing URLs do not count as a match", () => {
    expect(accountReadiness({}, null).advertiser_website_matches).toBeNull();
  });
  it("failed reads remain unverified and unavailable funding is explicit", async () => {
    const result = await chatgptAdsRunContext("tenant");
    expect(result.account.access).toBe("unverified");
    expect(result.funding.enabled).toBe(false);
  });
});
