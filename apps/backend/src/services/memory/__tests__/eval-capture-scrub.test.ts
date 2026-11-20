import { describe, it, expect } from "vitest";
import { scrubQueryForCapture, _MAX_QUERY_LEN } from "../eval-capture-scrub";

describe("scrubQueryForCapture — PII", () => {
  it("strips emails", () => {
    expect(scrubQueryForCapture("find disputes about alice@acme.com please")).toBe(
      "find disputes about [EMAIL] please",
    );
  });

  it("strips SSNs", () => {
    expect(scrubQueryForCapture("user ssn 123-45-6789 needs review")).toBe(
      "user ssn [SSN] needs review",
    );
  });

  it("strips US-format phone numbers", () => {
    expect(scrubQueryForCapture("call +1-555-867-5309 today")).toBe(
      "call [PHONE] today",
    );
    expect(scrubQueryForCapture("phone 555 123 4567 logged")).toBe(
      "phone [PHONE] logged",
    );
  });

  it("strips a valid Luhn credit card", () => {
    expect(scrubQueryForCapture("payment from 4532015112830366 declined")).toBe(
      "payment from [CARD] declined",
    );
  });

  it("does NOT strip a 16-digit non-Luhn run (e.g., VIN-shaped digits)", () => {
    const out = scrubQueryForCapture("vehicle id 1111111111111111 found");
    expect(out).toBe("vehicle id 1111111111111111 found");
  });

  it("leaves normal query text unchanged", () => {
    const q = "find every late-return dispute resolved in favor of the host";
    expect(scrubQueryForCapture(q)).toBe(q);
  });
});

describe("scrubQueryForCapture — secrets", () => {
  it("strips JWT tokens", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    expect(scrubQueryForCapture(`token: ${jwt}`)).toBe("token: [JWT]");
  });

  it("strips AWS access keys", () => {
    expect(scrubQueryForCapture("creds AKIAIOSFODNN7EXAMPLE leaked")).toBe(
      "creds [AWS_KEY] leaked",
    );
  });

  it("strips OpenAI sk-* keys", () => {
    expect(scrubQueryForCapture("api sk-abc123def456ghi789jkl012mno key")).toBe(
      "api [API_KEY] key",
    );
  });

  it("strips Stripe sk_live_* keys", () => {
    expect(
      scrubQueryForCapture("billing sk_live_abcdef1234567890abcdef12 broken"),
    ).toBe("billing [API_KEY] broken");
  });

  it("strips Bearer auth headers", () => {
    expect(
      scrubQueryForCapture("Authorization: Bearer abc.def.ghi.jkl.mno-pqr_stu in body"),
    ).toBe("Authorization: [BEARER] in body");
  });

  it("strips multi-line PEM blocks", () => {
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\nABC123\n-----END RSA PRIVATE KEY-----";
    expect(scrubQueryForCapture(`secret ${pem} end`)).toBe("secret [PEM] end");
  });
});

describe("scrubQueryForCapture — length cap", () => {
  it("truncates over-cap input", () => {
    const huge = "a".repeat(_MAX_QUERY_LEN + 1000);
    const out = scrubQueryForCapture(huge);
    expect(out.length).toBeLessThanOrEqual(_MAX_QUERY_LEN);
    expect(out.endsWith("[…truncated]")).toBe(true);
  });

  it("does not truncate at-cap input", () => {
    const exact = "a".repeat(_MAX_QUERY_LEN);
    const out = scrubQueryForCapture(exact);
    expect(out.length).toBe(_MAX_QUERY_LEN);
    expect(out.endsWith("[…truncated]")).toBe(false);
  });
});

describe("scrubQueryForCapture — edge cases", () => {
  it("handles empty string", () => {
    expect(scrubQueryForCapture("")).toBe("");
  });

  it("handles non-string defensively", () => {
    // @ts-expect-error — intentional misuse
    expect(scrubQueryForCapture(null)).toBe("");
    // @ts-expect-error — intentional misuse
    expect(scrubQueryForCapture(undefined)).toBe("");
    // @ts-expect-error — intentional misuse
    expect(scrubQueryForCapture(42)).toBe("");
  });

  it("handles mixed PII + secrets in one query", () => {
    const q = "email me at bob@x.io with token Bearer aaaaaaaaaaaaaaaaaaaaaaa";
    const out = scrubQueryForCapture(q);
    expect(out).toContain("[EMAIL]");
    expect(out).toContain("[BEARER]");
    expect(out).not.toContain("bob@x.io");
    expect(out).not.toContain("aaaaaaaa");
  });
});
