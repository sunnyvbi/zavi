import { describe, expect, it } from "vitest";
import { EMAIL_PROVIDERS, type ProviderCall } from "../providers";
import { probeEmail, runContentProbe, sanitizeProbe } from "../content-probe";
import { compareContent } from "../content-verify";
import { fakeMailchimp } from "./fake-tools";

describe("content probe", () => {
  it("records a match for a tool that stores what it was given, deletes its draft, sends nothing", async () => {
    const mc = fakeMailchimp();
    const call: ProviderCall = (tool_slug, args) => mc.exec({ tool_slug, user_id: "u", connected_account_id: "c", arguments: args });
    const fixture = await runContentProbe("mailchimp", {
      call,
      create: () => EMAIL_PROVIDERS.mailchimp.createCampaign(call, { title: "Zavi content probe", audience_id: "L1", subject: "s", preview_text: null, from_name: "Zavi probe", from_email: "probe@example.test", reply_to: null }),
      remove: async (_t, id) => {
        await call("MAILCHIMP_DELETE_CAMPAIGN", { campaign_id: id });
      },
      now: () => new Date("2026-10-12T00:00:00Z"),
    });
    expect(fixture.verdict).toEqual({ status: "match" });
    expect(fixture.verdict_raw).toEqual({ status: "match" });
    expect(fixture.sealed).toEqual({ html: sanitizeProbe(probeEmail("mailchimp").html), text: sanitizeProbe(probeEmail("mailchimp").text) });
    expect(compareContent("mailchimp", fixture.sealed, fixture.stored)).toEqual(fixture.verdict);
    expect(mc.campaigns).toHaveLength(0);
    expect(mc.count("MAILCHIMP_SEND_CAMPAIGN") + mc.count("MAILCHIMP_SEND_TEST_EMAIL")).toBe(0);
  });

  it("the probe email has the cases a tool is likely to rewrite (an entity-escaped href, an ampersand, a tag-looking text)", () => {
    const e = probeEmail("mailchimp");
    expect(e.html).toContain("&amp;b=2");
    expect(e.html).toContain("&lt;tag-looking&gt;");
  });

  it("sanitizes addresses, account-id digit runs and the tool's own tokens, keeping structure", () => {
    const s = sanitizeProbe('<a href="https://us21.list-manage.com/unsubscribe?u=1234567890&amp;id=abc">x</a> owner@realco.com 99887766');
    expect(s).toBe('<a href="https://us21.list-manage.com/unsubscribe?u=REDACTED&amp;id=REDACTED">x</a> user@example.test 00000000');
  });

  it("a tracking link keeps its encoded destination, so a canonicalizer can replay it", () => {
    const dest = "https://www.brightloop.test/probe?a=1&b=2";
    const tracked = `https://example.klclick1.com/ls/click/AbCdEfGhIjKlMnOpQr?upn=SECRETTOKEN123&url=${encodeURIComponent(dest)}`;
    const out = sanitizeProbe(`<a href="${tracked}">Open</a>`);
    expect(out).toContain("/ls/click/REDACTED");
    expect(out).toContain("upn=REDACTED");
    expect(out).not.toContain("SECRETTOKEN123");
    const href = /href="([^"]+)"/.exec(out)![1];
    expect(new URL(href).searchParams.get("url")).toBe(dest);
  });

  it("a destination that is not the probe's own is sanitized too, recursively: no token, address, id or fragment survives", () => {
    const real = "https://shop.realco.com/reset/1234567890?token=SECRET&email=a@b.com&utm_source=newsletter#frag-SECRET2";
    const tracked = `https://us21.list-manage.com/track/click?u=abc&id=def&url=${encodeURIComponent(real)}`;
    for (const out of [sanitizeProbe(`<a href="${tracked}">x</a>`), sanitizeProbe(`<a href="${real}">x</a>`), sanitizeProbe(real)]) {
      for (const leak of ["SECRET", "a@b.com", "a%40b.com", "1234567890", "frag-"]) expect(out).not.toContain(leak);
    }
    const kept = new URL(sanitizeProbe(real));
    expect(kept.pathname).toBe("/reset/REDACTED");
    expect(kept.searchParams.get("token")).toBe("REDACTED");
    expect(kept.searchParams.get("email")).toBe("REDACTED");
    expect(kept.searchParams.get("utm_source")).toBe("newsletter");
    expect(kept.hash).toBe("#REDACTED");
  });

  it("base64-ish path segments and query values are redacted; plain words stay", () => {
    const out = new URL(sanitizeProbe("https://x.example.com/unsubscribe/aGVsbG8+d29y=/abc123def?utm_campaign=c2VjcmV0dG9rZW4%3D"));
    expect(out.pathname).toBe("/unsubscribe/REDACTED/REDACTED");
    expect(out.searchParams.get("utm_campaign")).toBe("REDACTED");
  });

  it("trailing punctuation in running text is not part of the URL: the token before it is still redacted, the punctuation kept", () => {
    const out = sanitizeProbe("Reset at https://shop.realco.com/r/aGVsbG8+d29y=. Or https://shop.realco.com/r?token=abc123def456), thanks");
    expect(out).toContain("https://shop.realco.com/r/REDACTED. Or");
    expect(out).toContain("token=REDACTED), thanks");
    expect(out).not.toContain("aGVsbG8");
    expect(out).not.toContain("abc123def456");
  });

  it("the probe's own destination is kept whole, but a tool's added subscriber id on it is not", () => {
    const out = sanitizeProbe("https://www.brightloop.test/probe?a=1&b=2&mc_eid=9f8e7d6c5b");
    expect(new URL(out).searchParams.get("a")).toBe("1");
    expect(new URL(out).searchParams.get("b")).toBe("2");
    expect(new URL(out).searchParams.get("mc_eid")).toBe("REDACTED");
  });

  it("a recorded mismatch replays to the same mismatch", () => {
    const sealed = probeEmail("klaviyo");
    const stored = { proof: "ok" as const, html: sealed.html.replace("Line one", "Line 1"), text: sealed.text };
    const clean = { html: sanitizeProbe(sealed.html), text: sanitizeProbe(sealed.text) };
    const cleanStored = { proof: "ok" as const, html: sanitizeProbe(stored.html), text: sanitizeProbe(stored.text) };
    expect(compareContent("klaviyo", clean, cleanStored)).toEqual(compareContent("klaviyo", sealed, stored));
  });
});
