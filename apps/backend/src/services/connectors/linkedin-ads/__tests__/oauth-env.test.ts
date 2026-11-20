import { describe, expect, it, vi } from "vitest";

describe("linkedin_ads oauth env wiring", () => {
  it("authorizeUrl uses LINKEDIN_ADS_* creds, ads scopes, and the linkedin_ads callback", async () => {
    vi.stubEnv("LINKEDIN_ADS_CLIENT_ID", "785c3xy3q222fc");
    vi.stubEnv("LINKEDIN_ADS_CLIENT_SECRET", "test-secret");
    vi.stubEnv("LINKEDIN_SOCIAL_CLIENT_ID", "78mxb3cuzdj940");
    const { linkedinAdsConnector } = await import("../oauth");
    const url = new URL(
      linkedinAdsConnector.authorizeUrl(
        "state123",
        "http://localhost:3001/api/connectors/linkedin_ads/callback",
      ),
    );
    expect(url.origin + url.pathname).toBe("https://www.linkedin.com/oauth/v2/authorization");
    expect(url.searchParams.get("client_id")).toBe("785c3xy3q222fc");
    expect(url.searchParams.get("scope")).toBe("r_ads r_ads_reporting rw_ads r_organization_social");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3001/api/connectors/linkedin_ads/callback",
    );
    expect(url.searchParams.get("state")).toBe("state123");
    expect(url.searchParams.get("response_type")).toBe("code");
    vi.unstubAllEnvs();
  });
});
