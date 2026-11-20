import { describe, it, expect } from "vitest";
import { armBodySchema, listQuerySchema } from "../regression";

describe("armBodySchema", () => {
  const sig = "a".repeat(64);

  it("accepts a 64-char lowercase hex signature", () => {
    expect(armBodySchema.parse({ signature: sig })).toEqual({ signature: sig });
  });

  it("accepts an optional valid PR url", () => {
    const r = armBodySchema.parse({
      signature: sig,
      armed_pr_url: "https://github.com/rravi149/praxis/pull/725",
    });
    expect(r.armed_pr_url).toContain("/pull/725");
  });

  it("rejects a non-hex / wrong-length signature", () => {
    expect(() => armBodySchema.parse({ signature: "nothex" })).toThrow();
    expect(() => armBodySchema.parse({ signature: "A".repeat(64) })).toThrow();
    expect(() => armBodySchema.parse({ signature: "a".repeat(63) })).toThrow();
  });

  it("rejects a non-url armed_pr_url", () => {
    expect(() => armBodySchema.parse({ signature: sig, armed_pr_url: "not a url" })).toThrow();
  });

  it("rejects unknown keys (strict)", () => {
    expect(() => armBodySchema.parse({ signature: sig, p_armed_by: "x" })).toThrow();
  });
});

describe("listQuerySchema", () => {
  it("defaults limit to 50 and allows no status", () => {
    expect(listQuerySchema.parse({})).toEqual({ limit: 50 });
  });

  it("accepts the three valid statuses + coerces limit", () => {
    for (const status of ["pending", "armed", "regressed"]) {
      expect(listQuerySchema.parse({ status }).status).toBe(status);
    }
    expect(listQuerySchema.parse({ limit: "10" }).limit).toBe(10);
  });

  it("rejects an invalid status + out-of-range limit", () => {
    expect(() => listQuerySchema.parse({ status: "bogus" })).toThrow();
    expect(() => listQuerySchema.parse({ limit: 9999 })).toThrow();
  });
});
