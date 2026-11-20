import { describe, it, expect } from "vitest";
import { redactAgentText } from "../index";

describe("redactAgentText", () => {
  it("strips email / phone / SSN from free-prose reasoning text", () => {
    const out = redactAgentText(
      "Emailing the host jane@example.com about SSN 123-45-6789, call +1 415 555 0199.",
    );
    expect(out).not.toContain("jane@example.com");
    expect(out).not.toContain("123-45-6789");
    expect(out).not.toContain("415 555 0199");
    expect(out).toContain("‹redacted:email›");
    expect(out).toContain("‹redacted:ssn›");
    expect(out).toContain("‹redacted:phone›");
  });

  it("strips secret-shaped tokens (JWT / api-key)", () => {
    const out = redactAgentText(
      "token eyJabc.def.ghi and key sk-ABCDEFGHIJ1234567890",
    );
    expect(out).toContain("‹redacted:secret›");
    expect(out).not.toContain("sk-ABCDEFGHIJ1234567890");
  });

  it("leaves ordinary prose (and short numbers) untouched — no over-redaction", () => {
    const text = "Bumped the Summer-CA ad-set budget from $40 to $60 per day.";
    expect(redactAgentText(text)).toBe(text);
  });

  it("is idempotent on already-redacted text", () => {
    const once = redactAgentText("reach jane@example.com now");
    expect(redactAgentText(once)).toBe(once);
  });

  it("no-ops on empty input", () => {
    expect(redactAgentText("")).toBe("");
  });
});
