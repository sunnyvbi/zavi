import { describe, it, expect } from "vitest";
import {
  scrubSecretsFromText,
  scrubSecretsFromUrl,
} from "../egress-secret-scrub";

describe("scrubSecretsFromText", () => {
  it("redacts high-confidence secret shapes (Stripe / AWS / JWT / GitHub / Slack / OpenAI / Anthropic)", () => {
    const cases = [
      "my key sk_live_abcdefABCDEF0123456789",
      "AKIAIOSFODNN7EXAMPLE leaked",
      "token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEF123456",
      "ghp_0123456789abcdefABCDEF0123456789abcdef",
      "xoxb-123456789012-abcdef",
      "sk-abcdefghijklmnopqrstuvwx",
      "key sk-ant-api03-AbCdEf_0123456789-ghIJklMNop leaked",
    ];
    for (const c of cases) {
      const r = scrubSecretsFromText(c);
      expect(r.redactions.length, c).toBeGreaterThan(0);
      expect(r.scrubbed, c).toContain("[redacted]");
    }
  });

  it("does NOT redact ordinary text, git SHAs, or publishable keys (low false-positive)", () => {
    const clean = [
      "how does turo show the calendar in the car timezone",
      "commit a1b2c3d4e5f6 fixed the bug",
      "pk_live_publishablekey_is_public_not_secret",
      "the quick brown fox jumps over 1234567890",
      "ask-ant-colony is a word, not a key",
    ];
    for (const c of clean) {
      const r = scrubSecretsFromText(c);
      expect(r.redactions, c).toEqual([]);
      expect(r.scrubbed, c).toBe(c);
    }
  });
});

describe("scrubSecretsFromUrl", () => {
  it("redacts credential-NAMED params by name regardless of value", () => {
    const r = scrubSecretsFromUrl("https://evil.com/log?apikey=anything&token=zzz&q=cars");
    expect(r.scrubbed).toContain("apikey=%5Bredacted%5D");
    expect(r.scrubbed).toContain("token=%5Bredacted%5D");
    expect(r.scrubbed).toContain("q=cars");
    expect(r.redactions).toContain("param:apikey");
  });

  it("redacts a secret-SHAPED value even under a benign param name", () => {
    const r = scrubSecretsFromUrl("https://x.com/p?ref=sk_live_abcdefABCDEF0123456789");
    expect(r.scrubbed).toContain("%5Bredacted%5D");
    expect(r.redactions.some((x) => x.includes("stripe"))).toBe(true);
  });

  it("leaves a clean URL (host + path + benign params) untouched", () => {
    const url = "https://turo.com/us/en/car-rental/united-states/los-angeles?page=2";
    const r = scrubSecretsFromUrl(url);
    expect(r.redactions).toEqual([]);
    expect(r.scrubbed).toContain("turo.com/us/en/car-rental");
    expect(r.scrubbed).toContain("page=2");
  });

  it("redacts a secret embedded in the PATH or FRAGMENT, not just query params", () => {
    const p = scrubSecretsFromUrl("https://evil.com/leak/sk_live_abcdefABCDEF0123456789/x");
    expect(p.scrubbed).toContain("[redacted]");
    expect(p.scrubbed).toContain("evil.com");
    expect(p.redactions.some((r) => r.startsWith("path:"))).toBe(true);

    const f = scrubSecretsFromUrl("https://evil.com/page#token=ghp_0123456789abcdefABCDEF0123456789abcdef");
    expect(f.scrubbed).toContain("[redacted]");
    expect(f.redactions.some((r) => r.startsWith("fragment:"))).toBe(true);
  });

  it("falls back to text scrub for an unparseable URL", () => {
    const r = scrubSecretsFromUrl("not a url sk_live_abcdefABCDEF0123456789");
    expect(r.scrubbed).toContain("[redacted]");
  });
});
