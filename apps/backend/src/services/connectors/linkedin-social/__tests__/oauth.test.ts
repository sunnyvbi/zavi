import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { linkedinSocialAuthorizeUrl } from "../oauth";

describe("linkedinSocialAuthorizeUrl", () => {
  const prevId = process.env.LINKEDIN_SOCIAL_CLIENT_ID;
  const prevSecret = process.env.LINKEDIN_SOCIAL_CLIENT_SECRET;

  beforeEach(() => {
    process.env.LINKEDIN_SOCIAL_CLIENT_ID = "test-client";
    process.env.LINKEDIN_SOCIAL_CLIENT_SECRET = "test-secret";
  });

  afterEach(() => {
    if (prevId === undefined) delete process.env.LINKEDIN_SOCIAL_CLIENT_ID;
    else process.env.LINKEDIN_SOCIAL_CLIENT_ID = prevId;
    if (prevSecret === undefined) delete process.env.LINKEDIN_SOCIAL_CLIENT_SECRET;
    else process.env.LINKEDIN_SOCIAL_CLIENT_SECRET = prevSecret;
  });

  it("requests openid, profile, and w_member_social", () => {
    const url = new URL(
      linkedinSocialAuthorizeUrl("state-abc", "https://api.example/callback"),
    );
    expect(url.hostname).toBe("www.linkedin.com");
    expect(url.pathname).toBe("/oauth/v2/authorization");
    expect(url.searchParams.get("scope")).toContain("w_member_social");
    expect(url.searchParams.get("client_id")).toBe("test-client");
    expect(url.searchParams.get("state")).toBe("state-abc");
    expect(url.searchParams.get("redirect_uri")).toBe("https://api.example/callback");
  });
});
