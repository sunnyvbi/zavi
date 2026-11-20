import { describe, expect, it } from "vitest";
import { renderAppInviteEmail } from "../app-invite";

const URL_ = "https://acme.zaviagent.com/signup?invite=AbC_123-xyzAbC_123-xyzAbC_123-xyzAbC_12345";

describe("renderAppInviteEmail", () => {
  it("uses the shared shell, links the exact invite URL and states the expiry", () => {
    const r = renderAppInviteEmail({ inviteUrl: URL_, siteHost: "acme.zaviagent.com", role: "user", expiresAt: "2026-10-06T00:00:00.000Z" });
    expect(r.subject).toBe("You've been invited to join acme.zaviagent.com");
    expect(r.html).toContain("<!doctype html>");
    expect(r.html).toContain(`href="${URL_}"`);
    expect(r.html).toContain(">Accept invite</a>");
    expect(r.html).toContain("October 6, 2026");
    expect(r.text).toContain(URL_);
    expect(r.html).not.toMatch(/admin/i);
  });

  it("says plainly when the invite grants admin", () => {
    const r = renderAppInviteEmail({ inviteUrl: URL_, siteHost: "acme.zaviagent.com", role: "admin", expiresAt: "2026-10-06T00:00:00.000Z" });
    expect(r.subject).toBe("You've been invited to help run acme.zaviagent.com");
    expect(r.html).toContain("as an admin");
    expect(r.text).toContain("admin account");
  });

  it("escapes a hostile host and URL instead of rendering markup", () => {
    const r = renderAppInviteEmail({
      inviteUrl: 'https://x.test/signup?invite=a"><script>alert(1)</script>',
      siteHost: "<img src=x onerror=alert(1)>",
      role: "user",
      expiresAt: "not a date",
    });
    expect(r.html).not.toContain("<script>");
    expect(r.html).not.toContain("<img src=x");
    expect(r.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(r.html).toContain("expires in 7 days");
  });
});
