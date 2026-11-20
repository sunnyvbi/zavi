
import { describe, it, expect } from "vitest";
import { baseSlug } from "../tenant-slug";

describe("baseSlug never ends in a hyphen", () => {
  it("strips the hyphen the slice re-introduced", () => {
    const base = baseSlug("a".repeat(39) + " bright ideas", 40);
    expect(base.endsWith("-")).toBe(false);
    expect(`${base}-abcd1234`).not.toContain("--");
  });

  it("leaves ordinary names alone", () => {
    expect(baseSlug("Acme Labs", 40)).toBe("acme-labs");
    expect(baseSlug("  Acme  ", 40)).toBe("acme");
  });

  it("still falls back rather than returning an empty slug", () => {
    expect(baseSlug("!!!", 40)).toBe("company");
    expect(baseSlug("", 40)).toBe("company");
  });
});
