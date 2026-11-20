import { describe, expect, it } from "vitest";
import { googleConnectBackTarget, googleConnectFailReason, googleOAuthErrorFailure, renderGoogleConnectFailHtml } from "../google-connect-fail";

describe("googleOAuthErrorFailure", () => {
  it("only a real access_denied tells the person to click Allow", () => {
    expect(googleOAuthErrorFailure("access_denied")).toBe("access_denied");
    expect(googleConnectFailReason("access_denied")).toMatch(/click Allow/);
  });

  it("a Workspace admin block says to ask the admin", () => {
    for (const code of ["admin_policy_enforced", "org_internal"]) {
      expect(googleOAuthErrorFailure(code)).toBe("blocked_by_admin");
    }
    expect(googleConnectFailReason("blocked_by_admin")).toMatch(/admin/);
  });

  it("any other Google error does not claim the person refused access", () => {
    expect(googleOAuthErrorFailure("invalid_request")).toBe("google_refused");
    expect(googleConnectFailReason("google_refused")).not.toMatch(/click Allow/);
  });
});

describe("Back to Zavi after a failed Google connect", () => {
  it("carries the product and reason, so the workspace returns the founder to Connect with the reason", () => {
    const html = renderGoogleConnectFailHtml("google_analytics", "google_scope_missing");
    const href = /id="back" href="([^"]+)"/.exec(html)?.[1]?.replace(/&amp;/g, "&");
    expect(href).toBe("http://localhost:3000/workspace?tab=settings&composio_error=google_analytics&code=google_scope_missing");
    expect(html).toContain("tick the Google Analytics box");
  });

  it("the opener redirect uses the same target as the link", () => {
    const html = renderGoogleConnectFailHtml("google_search_console", "google_scope_missing");
    expect(html).toContain(JSON.stringify(googleConnectBackTarget("google_search_console", "google_scope_missing")));
  });

  it("with no product it stays the plain Settings landing", () => {
    expect(googleConnectBackTarget()).toBe("http://localhost:3000/workspace?tab=settings");
  });
});
