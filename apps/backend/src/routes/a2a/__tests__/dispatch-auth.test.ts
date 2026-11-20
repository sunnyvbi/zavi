
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { checkSecret } from "../dispatch";

function reqWithAuth(value?: string): { header: (name: string) => string | undefined } {
  return { header: (name: string) => (name.toLowerCase() === "authorization" ? value : undefined) };
}

describe("a2a checkSecret — fail-closed auth", () => {
  const ORIGINAL = process.env.PRAXIS_A2A_SHARED_SECRET;
  beforeEach(() => {
    delete process.env.PRAXIS_A2A_SHARED_SECRET;
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.PRAXIS_A2A_SHARED_SECRET;
    else process.env.PRAXIS_A2A_SHARED_SECRET = ORIGINAL;
  });

  it("REJECTS when the secret is unset, even with a header (fail-closed)", () => {
    expect(checkSecret(reqWithAuth(undefined))).toBe(false);
    expect(checkSecret(reqWithAuth("A2A anything"))).toBe(false);
  });

  it("REJECTS when the secret is set but the header is missing", () => {
    process.env.PRAXIS_A2A_SHARED_SECRET = "s3cret";
    expect(checkSecret(reqWithAuth(undefined))).toBe(false);
  });

  it("REJECTS when the secret is set but the header value is wrong", () => {
    process.env.PRAXIS_A2A_SHARED_SECRET = "s3cret";
    expect(checkSecret(reqWithAuth("A2A wrong"))).toBe(false);
    expect(checkSecret(reqWithAuth("Bearer s3cret"))).toBe(false);
    expect(checkSecret(reqWithAuth("s3cret"))).toBe(false);
  });

  it("ACCEPTS only the exact 'A2A <secret>' header when the secret is set", () => {
    process.env.PRAXIS_A2A_SHARED_SECRET = "s3cret";
    expect(checkSecret(reqWithAuth("A2A s3cret"))).toBe(true);
  });
});
