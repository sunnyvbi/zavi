
import { describe, it, expect } from "vitest";
import { coerceProductUrl } from "./useProductUrl";

describe("coerceProductUrl", () => {
  it("keeps string urls", () => {
    expect(
      coerceProductUrl({ marketing: "https://latest.upcar.ai/", api: "https://api.x" }),
    ).toEqual({ marketing: "https://latest.upcar.ai/", api: "https://api.x" });
  });

  it("keeps marketing when api is absent (the common shape)", () => {
    expect(coerceProductUrl({ marketing: "https://x.com" })).toEqual({
      marketing: "https://x.com",
    });
  });

  it("treats an unset / empty column as no url on file", () => {
    expect(coerceProductUrl({})).toEqual({});
    expect(coerceProductUrl(null)).toEqual({});
    expect(coerceProductUrl(undefined)).toEqual({});
  });

  it("drops non-string values instead of handing them to an <input>", () => {
    expect(coerceProductUrl({ marketing: 42 })).toEqual({});
    expect(coerceProductUrl({ marketing: { url: "https://x.com" } })).toEqual({});
    expect(coerceProductUrl({ marketing: ["https://x.com"] })).toEqual({});
    expect(coerceProductUrl({ marketing: true })).toEqual({});
  });

  it("treats an empty-string url as absent, not as a loadable url", () => {
    expect(coerceProductUrl({ marketing: "" })).toEqual({});
  });

  it("ignores a non-object column (array / scalar)", () => {
    expect(coerceProductUrl(["https://x.com"])).toEqual({});
    expect(coerceProductUrl("https://x.com")).toEqual({});
  });

  it("keeps only known keys", () => {
    expect(
      coerceProductUrl({ marketing: "https://x.com", evil: "https://attacker" }),
    ).toEqual({ marketing: "https://x.com" });
  });
});
