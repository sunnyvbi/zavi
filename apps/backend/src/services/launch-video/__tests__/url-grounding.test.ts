import { describe, it, expect } from "vitest";
import { hostOf, ungroundedHosts, productUrlToHosts } from "../url-grounding";

describe("hostOf", () => {
  it("normalizes scheme-less and www hosts", () => {
    expect(hostOf("https://www.upcar.ai/host")).toBe("upcar.ai");
    expect(hostOf("upcar.ai")).toBe("upcar.ai");
    expect(hostOf("HTTPS://Upcar.AI")).toBe("upcar.ai");
  });

  it("returns null for junk", () => {
    expect(hostOf("")).toBeNull();
    expect(hostOf("   ")).toBeNull();
  });

  it("returns null (does not throw) for a non-string input", () => {
    // @ts-expect-error — deliberately passing the wrong type the DB actually produced
    expect(hostOf({ marketing: "https://www.apnatutor.live" })).toBeNull();
    // @ts-expect-error
    expect(hostOf(null)).toBeNull();
    // @ts-expect-error
    expect(hostOf(42)).toBeNull();
  });
});

describe("productUrlToHosts", () => {
  it("extracts every host from the real JSONB object shape", () => {
    expect(
      productUrlToHosts({
        api: "https://api.apnatutor.live",
        marketing: "https://www.apnatutor.live",
      }).sort(),
    ).toEqual(["api.apnatutor.live", "apnatutor.live"]);
  });

  it("still accepts a legacy bare string", () => {
    expect(productUrlToHosts("https://www.upcar.ai")).toEqual(["upcar.ai"]);
  });

  it("returns [] for null / garbage / non-string values", () => {
    expect(productUrlToHosts(null)).toEqual([]);
    expect(productUrlToHosts(undefined)).toEqual([]);
    expect(productUrlToHosts({ api: 42, marketing: null })).toEqual([]);
    expect(productUrlToHosts(99)).toEqual([]);
  });
});

describe("ungroundedHosts", () => {
  it("REFUSES a host the customer never named (the upcar.com incident)", () => {
    const bad = ungroundedHosts(["https://upcar.com", "https://upcar.com"], {
      productHosts: [],
      userTexts: [
        "can you generate a video on how Upcar works that we can share with our hosts?",
        "new hosts",
        "Go and build it",
      ],
    });
    expect(bad).toEqual(["upcar.com"]);
  });

  it("accepts a host the customer typed themselves", () => {
    expect(
      ungroundedHosts(["https://upcar.ai/host"], {
        productHosts: [],
        userTexts: ["send them to upcar.ai/host"],
      }),
    ).toEqual([]);
  });

  it("accepts the tenant's recorded product hosts and their subdomains", () => {
    const sources = { productHosts: ["upcar.ai"], userTexts: [] };
    expect(ungroundedHosts(["https://upcar.ai/host"], sources)).toEqual([]);
    expect(ungroundedHosts(["https://list.upcar.ai/start"], sources)).toEqual([]);
  });

  it("grounds a CTA against any host from the real object product_url (apna-tutor)", () => {
    const sources = {
      productHosts: productUrlToHosts({
        api: "https://api.apnatutor.live",
        marketing: "https://www.apnatutor.live",
      }),
      userTexts: [],
    };
    expect(ungroundedHosts(["https://www.apnatutor.live"], sources)).toEqual([]);
    expect(ungroundedHosts(["apnatutor.live"], sources)).toEqual([]);
    expect(ungroundedHosts(["https://api.apnatutor.live/v1"], sources)).toEqual([]);
    expect(ungroundedHosts(["https://apnatutor.com"], sources)).toEqual(["apnatutor.com"]);
  });

  it("REFUSES a look-alike domain even when product hosts are set", () => {
    expect(
      ungroundedHosts(["https://upcar.com"], { productHosts: ["upcar.ai"], userTexts: [] }),
    ).toEqual(["upcar.com"]);
    expect(
      ungroundedHosts(["https://evilupcar.ai"], { productHosts: ["upcar.ai"], userTexts: [] }),
    ).toEqual(["evilupcar.ai"]);
  });

  it("does not corroborate from an empty source set", () => {
    expect(ungroundedHosts(["https://anything.example"], { productHosts: [], userTexts: [] })).toEqual([
      "anything.example",
    ]);
  });

  it("reports every distinct offending host once", () => {
    const bad = ungroundedHosts(["https://a.example", "https://b.example", "https://a.example/x"], {
      productHosts: [],
      userTexts: [],
    });
    expect(bad.sort()).toEqual(["a.example", "b.example"]);
  });

  it("treats an unparseable url as ungrounded", () => {
    expect(ungroundedHosts(["   "], { productHosts: ["upcar.ai"], userTexts: [] })).toEqual([
      "(unparseable)",
    ]);
  });
});
