import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ crawl: vi.fn(), audit: vi.fn(), search: vi.fn() }));
vi.mock("@/services/mcp/internal/web-search", () => ({ callWebSearchTool: m.search }));
vi.mock("@/services/onboarding/enrichment/run", () => ({
  retryOnce: (fn: () => Promise<unknown>) => fn(),
  runEnrichment: m.crawl,
}));
vi.mock("@/services/settings", () => ({ getAppSetting: vi.fn() }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));
vi.mock("@/services/tenant-client", () => ({
  globalClient: () => ({ from: () => ({ insert: m.audit }) }),
  startCardRpc: vi.fn(),
}));
vi.mock("@/services/vendors/usage", () => ({ withVendorContext: (_ctx: unknown, fn: () => unknown) => fn() }));
import { runWebsiteScan } from "../scan";
beforeEach(() => {
  vi.clearAllMocks();
  m.crawl.mockImplementation(async ({ domain }: {domain: string}) => ({
    status: "ok",
    payload: { domain_pages: [{url: `https://${domain}/`}], app_listings: [], research_pages: [] },
    competitors: [],
    company_name: domain === "example-clinic.netlify.app" ? "Example Clinic" : "Hosting Provider",
    estimated_cost_usd: 0,
    spend_inputs: {enrichmentTokens:0, domain_pages:1, research_pages:0, app_listings:0, tavilyCalls:0, fetchCalls:0, apifyCalls:0},
  }));
});
it("the background website scan passes the customer's host into enrichment", async () => {
  const result = await runWebsiteScan("example-clinic.netlify.app", "test-user");
  expect(m.crawl).toHaveBeenCalledWith({domain:"example-clinic.netlify.app",orgName:"Example Clinic"});
  expect(result).toMatchObject({status:"ok",company_name:"Example Clinic",domain_pages:[{url:"https://example-clinic.netlify.app/"}]});
  expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({resolved_domain:"example-clinic.netlify.app"}));
  expect(m.search).not.toHaveBeenCalled();
});
it("an unsupported social profile never starts enrichment", async () => {
  expect(await runWebsiteScan("www.facebook.com", "test-user")).toMatchObject({status:"skipped",reason:"domain_match_failed"});
  expect(m.crawl).not.toHaveBeenCalled();
});
