import { describe, expect, it } from "vitest";
import { INVITER_FALLBACK, renderWorkspaceInviteEmail } from "../workspace-invite";

const actionUrl = "https://www.zaviagent.com/invite/accept?id=invite-123&deeplink=invite";
const preheaderOf = (html: string) => /display:none[^>]*>([^<]*)</.exec(html)?.[1];
const noDashes = (s: string) => expect(s).not.toMatch(/[\u2013\u2014]|--|&mdash;|&ndash;/);

describe("renderWorkspaceInviteEmail", () => {
  it("names the inviter (with their email) and the company, in the shared branded shell", () => {
    const r = renderWorkspaceInviteEmail({
      actionUrl,
      inviterLabel: "Priya Shah",
      inviterEmail: "priya@acmerentals.com",
      tenantName: "Acme Rentals",
    });
    expect(r.subject).toBe("Priya Shah invited you to Acme Rentals on Zavi");
    expect(preheaderOf(r.html)).toBe("Priya Shah (priya@acmerentals.com) invited you to join Acme Rentals on Zavi.");
    expect(r.html).toContain("Join <em>Acme Rentals</em> on Zavi");
    expect(r.html).toContain(
      "Priya Shah (priya@acmerentals.com) invited you to work on Acme Rentals&#39; growth with them on Zavi. You&#39;ll sign in first if you&#39;re not already.",
    );
    expect(r.html).toContain(">Join Acme Rentals</a>");
    expect(r.html).toContain("Don&#39;t know Priya? You can ignore this email. Nothing changes until you accept.");
    expect(r.html).toContain("This link is just for you. Zavi will never ask you to share it.");
    expect(r.html).toContain(`href="${actionUrl.replace("&", "&amp;")}"`);
    expect(r.html).toContain(">Zavi</a>");
    expect(r.html).not.toMatch(/<img[^>]*zavi-wordmark/i);
    expect(r.html).not.toContain("Your growth, run by Zavi.");
    expect(r.text).toContain("Priya Shah (priya@acmerentals.com) invited you to work on Acme Rentals' growth with them on Zavi.");
    expect(r.text).toContain(actionUrl);
    expect(r.text).toContain("Don't know Priya?");
    for (const part of [r.subject, r.text, r.html]) noDashes(part);
  });

  it("escapes every user-typed name, once", () => {
    const r = renderWorkspaceInviteEmail({
      actionUrl,
      inviterLabel: "<script>alert(1)</script> & Co",
      inviterEmail: "x@y.z",
      tenantName: "Acme <b>&</b> Sons",
    });
    expect(r.html).not.toContain("<script>");
    expect(r.html).not.toContain("<b>");
    expect(r.html).toContain("Join <em>Acme &lt;b&gt;&amp;&lt;/b&gt; Sons</em> on Zavi");
    expect(r.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; Co (x@y.z)");
    const body = r.html.slice(r.html.indexOf("<body"));
    expect(body).not.toContain("&amp;amp;");
    expect(body).not.toContain("&amp;lt;");
  });

  it("keeps CR/LF and control characters out of the subject", () => {
    const r = renderWorkspaceInviteEmail({
      actionUrl,
      inviterLabel: "Priya\r\nBcc: victim@example.com",
      tenantName: "Acme\nRentals\u0007",
    });
    expect(r.subject).not.toMatch(/[\r\n\u0000-\u001f]/);
    expect(r.subject).toBe("Priya Bcc: victim@example.com invited you to Acme Rentals on Zavi");
  });

  it("an inviter known only by email: the email is the name, said once", () => {
    const r = renderWorkspaceInviteEmail({ actionUrl, inviterLabel: "priya@acme.com", inviterEmail: null, tenantName: "Acme" });
    expect(r.subject).toBe("priya@acme.com invited you to Acme on Zavi");
    expect(preheaderOf(r.html)).toBe("priya@acme.com invited you to join Acme on Zavi.");
    expect(r.html).toContain("invited you to work on Acme&#39;s growth with them on Zavi");
    expect(r.html).toContain("Don&#39;t know priya@acme.com?");
  });

  it("no inviter could be read: 'A workspace admin', and the generic ignore line", () => {
    const r = renderWorkspaceInviteEmail({ actionUrl, inviterLabel: INVITER_FALLBACK, tenantName: "Acme Rentals" });
    expect(r.subject).toBe("A workspace admin invited you to Acme Rentals on Zavi");
    expect(r.html).toContain("Didn&#39;t expect this invite? You can ignore this email.");
    expect(r.html).not.toContain("Don&#39;t know");
    expect(renderWorkspaceInviteEmail({ actionUrl, inviterLabel: "  ", tenantName: "Acme" }).subject).toBe(
      "A workspace admin invited you to Acme on Zavi",
    );
  });

  it("no company name: worded around it, never 'null'", () => {
    const r = renderWorkspaceInviteEmail({ actionUrl, inviterLabel: "Priya Shah", tenantName: null });
    expect(r.subject).toBe("Priya Shah invited you to a workspace on Zavi");
    expect(r.html).toContain("Join the <em>workspace</em>");
    expect(r.html).toContain(">Join workspace</a>");
    expect(r.html).toContain("Priya Shah invited you to join their workspace on Zavi.");
    for (const part of [r.subject, r.text, r.html]) {
      expect(part).not.toMatch(/null|undefined/);
      noDashes(part);
    }
  });
});
