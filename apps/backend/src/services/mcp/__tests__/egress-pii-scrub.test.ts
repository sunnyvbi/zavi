import { describe, it, expect } from "vitest";
import {
  scrubSecretsFromText,
  scrubSecretsFromUrl,
  scrubSecretsFromArgs,
} from "../egress-secret-scrub";

describe("PII scrub — positive: query-param VALUES are scanned", () => {
  it("redacts an email in a param value", () => {
    const r = scrubSecretsFromUrl("https://evil.test/collect?q=jane.doe%40acme.com");
    expect(r.scrubbed).not.toContain("jane.doe@acme.com");
    expect(r.scrubbed).toContain("redacted");
    expect(r.redactions).toContain("param:q:email");
  });

  it("redacts an E.164 phone in a param value", () => {
    const r = scrubSecretsFromUrl("https://evil.test/c?p=%2B14155550123");
    expect(r.scrubbed).not.toContain("14155550123");
    expect(r.redactions).toContain("param:p:phone");
  });

  it("redacts a NANP-punctuated phone in a param value", () => {
    const r = scrubSecretsFromUrl("https://evil.test/c?p=415-555-0123");
    expect(r.scrubbed).not.toContain("415-555-0123");
    expect(r.redactions).toContain("param:p:phone");
  });

  it("redacts BOTH a secret and PII in the same value, reporting both", () => {
    const r = scrubSecretsFromUrl(
      "https://evil.test/c?d=sk_live_AAAAAAAAAAAAAAAAAAAA%20jane%40acme.com",
    );
    expect(r.scrubbed).not.toContain("sk_live_");
    expect(r.scrubbed).not.toContain("jane@acme.com");
    expect(r.redactions).toContain("param:d:stripe_secret_key");
    expect(r.redactions).toContain("param:d:email");
  });
});

describe("PII scrub — NEGATIVE: everything outside param values is untouched", () => {
  it("FREE TEXT is not PII-scrubbed (a research query must survive intact)", () => {
    const q = "who is the contact at acme? try jane.doe@acme.com or 415-555-0123";
    const r = scrubSecretsFromText(q);
    expect(r.scrubbed).toBe(q);
    expect(r.redactions).toEqual([]);
  });

  it("a URL PATH containing an email shape is not PII-scrubbed", () => {
    const r = scrubSecretsFromUrl("https://api.test/users/jane.doe@acme.com/profile");
    expect(r.scrubbed).toContain("jane.doe@acme.com");
    expect(r.redactions).toEqual([]);
  });

  it("a URL FRAGMENT containing an email shape is not PII-scrubbed", () => {
    const r = scrubSecretsFromUrl("https://api.test/page#contact=jane.doe@acme.com");
    expect(r.scrubbed).toContain("jane.doe@acme.com");
    expect(r.redactions).toEqual([]);
  });

  it("the MALFORMED-URL text fallback is not PII-scrubbed", () => {
    const raw = "not a url at all — jane.doe@acme.com 415-555-0123";
    const r = scrubSecretsFromUrl(raw);
    expect(r.scrubbed).toBe(raw);
    expect(r.redactions).toEqual([]);
  });

  it("non-URL arg leaves are not PII-scrubbed (they route through free text)", () => {
    const args = { note: "ping jane.doe@acme.com", to: "415-555-0123" };
    const r = scrubSecretsFromArgs(args);
    expect(JSON.stringify(r.scrubbed)).toContain("jane.doe@acme.com");
    expect(r.redactions).toEqual([]);
  });

  it("a URL-shaped arg leaf DOES get param PII scrubbing (the exfil channel)", () => {
    const r = scrubSecretsFromArgs({ url: "https://evil.test/c?q=jane.doe@acme.com" });
    expect(JSON.stringify(r.scrubbed)).not.toContain("jane.doe@acme.com");
    expect(r.redactions).toContain("param:q:email");
  });
});

describe("PII scrub — precision guards (false positives break real fetches)", () => {
  it("a bare 10-digit id in a param is NOT treated as a phone", () => {
    const r = scrubSecretsFromUrl("https://api.test/o?order_id=4155550123");
    expect(r.scrubbed).toContain("4155550123");
    expect(r.redactions).toEqual([]);
  });

  it("a dollar figure in a param is NOT redacted (price filters are legitimate)", () => {
    const r = scrubSecretsFromUrl("https://shop.test/s?max_price=%2499.99&budget=1500");
    expect(r.scrubbed).toContain("99.99");
    expect(r.scrubbed).toContain("1500");
    expect(r.redactions).toEqual([]);
  });

  it("a person's NAME in a param is NOT redacted (no name detector by design)", () => {
    const r = scrubSecretsFromUrl("https://api.test/s?q=Jane%20Doe%20Acme%20Corp");
    expect(r.scrubbed).toContain("Jane");
    expect(r.redactions).toEqual([]);
  });

  it("a normal search param is byte-identical", () => {
    const url = "https://www.test/search?q=marketplace+growth+2026&page=2";
    expect(scrubSecretsFromUrl(url).scrubbed).toBe(url);
  });
});

describe("PII scrub — credential regression (pre-existing behavior preserved)", () => {
  it("credential-NAMED params still redact by name", () => {
    const r = scrubSecretsFromUrl("https://api.test/x?api_key=anything123");
    expect(r.scrubbed).not.toContain("anything123");
    expect(r.redactions).toContain("param:api_key");
  });

  it("secret SHAPES still redact from free text", () => {
    const r = scrubSecretsFromText("token sk_live_AAAAAAAAAAAAAAAAAAAA here");
    expect(r.scrubbed).not.toContain("sk_live_");
    expect(r.redactions).toContain("stripe_secret_key");
  });

  it("secret shapes in a PATH still redact", () => {
    const r = scrubSecretsFromUrl("https://evil.test/sk_live_AAAAAAAAAAAAAAAAAAAA/x");
    expect(r.scrubbed).not.toContain("sk_live_");
    expect(r.redactions.some((x) => x.startsWith("path:"))).toBe(true);
  });
});

describe("PII scrub — codex review fixes (2026-07-21)", () => {
  it("duplicate params: redacting one occurrence does not delete the other", () => {
    const r = scrubSecretsFromUrl(
      "https://x.test/c?q=jane.doe%40acme.com&q=keep-me",
    );
    expect(r.scrubbed).not.toContain("jane.doe@acme.com");
    expect(r.scrubbed).toContain("keep-me");
    expect(r.redactions).toEqual(["param:q:email"]);
  });

  it("duplicate params keep their original ORDER after a rebuild", () => {
    const r = scrubSecretsFromUrl(
      "https://x.test/c?a=1&q=jane%40acme.com&b=2&q=keep-me&c=3",
    );
    const order = Array.from(new URL(r.scrubbed).searchParams.keys());
    expect(order).toEqual(["a", "q", "b", "q", "c"]);
  });

  it("a clean URL is byte-identical (no re-encoding when nothing redacted)", () => {
    const url = "https://x.test/s?q=a+b&tag=x%2Cy&n=1";
    expect(scrubSecretsFromUrl(url).scrubbed).toBe(url);
  });

  it("email: invalid domain shapes are NOT redacted", () => {
    for (const bad of ["a@-x.com", "a@x-.com", "a@x..com", "a@.com"]) {
      const r = scrubSecretsFromUrl(`https://x.test/c?v=${encodeURIComponent(bad)}`);
      expect(r.redactions, `expected no redaction for ${bad}`).toEqual([]);
    }
  });

  it("phone: over-long and structurally-broken shapes are NOT redacted", () => {
    for (const bad of ["+123456789012345678", "415)-555-0123"]) {
      const r = scrubSecretsFromUrl(`https://x.test/c?v=${encodeURIComponent(bad)}`);
      expect(r.redactions, `expected no redaction for ${bad}`).toEqual([]);
    }
  });

  it("phone: a stray leading paren still redacts — it IS a real number", () => {
    const r = scrubSecretsFromUrl("https://x.test/c?v=%28415-555-0123");
    expect(r.redactions).toContain("param:v:phone");
  });

  it("phone: balanced-paren NANP still redacts", () => {
    const r = scrubSecretsFromUrl("https://x.test/c?v=%28415%29%20555-0123");
    expect(r.redactions).toContain("param:v:phone");
  });

  it("phone: a valid 15-digit E.164 still redacts (spec maximum)", () => {
    const r = scrubSecretsFromUrl("https://x.test/c?v=%2B123456789012345");
    expect(r.redactions).toContain("param:v:phone");
  });
});
