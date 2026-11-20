import { describe, expect, it } from "vitest";
import { toPageContext } from "./page-context";
import type { PageCapture } from "./capture";

const base: PageCapture = {
  url: "https://adsmanager.facebook.com/adsmanager/manage",
  title: "Ads Manager",
  adapter: null,
  truncated: false,
};

describe("toPageContext", () => {
  it("observation mode sends url and title and NOTHING else", () => {
    expect(toPageContext(base)).toEqual({
      url: "https://adsmanager.facebook.com/adsmanager/manage",
      title: "Ads Manager",
    });
  });

  it("never emits a `dom` field", () => {
    const hit = toPageContext({
      ...base,
      adapter: { adapter_id: "meta_ads", schema_version: 1, extraction: { a: 1 } },
    });
    expect(Object.keys(hit)).not.toContain("dom");
    expect(Object.keys(toPageContext(base))).not.toContain("dom");
  });

  it("an adapter hit sends the typed extraction with its id and version", () => {
    expect(
      toPageContext({
        ...base,
        adapter: {
          adapter_id: "meta_ads",
          schema_version: 1,
          extraction: {
            account: { currency: "USD" },
            campaigns: [{ name: "Prospecting", spend: 4201.55, cpa: 84.2 }],
          },
        },
      }),
    ).toEqual({
      url: "https://adsmanager.facebook.com/adsmanager/manage",
      title: "Ads Manager",
      adapter_id: "meta_ads",
      schema_version: 1,
      extraction: {
        account: { currency: "USD" },
        campaigns: [{ name: "Prospecting", spend: 4201.55, cpa: 84.2 }],
      },
    });
  });

  it("does not leak the client-only `truncated` flag onto the wire", () => {
    const out = toPageContext({ ...base, truncated: true });
    expect(Object.keys(out)).toEqual(["url", "title"]);
  });

  it("serializes to JSON with no surprises", () => {
    const out = toPageContext({
      ...base,
      adapter: { adapter_id: "meta_ads", schema_version: 2, extraction: { rows: [] } },
    });
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
  });
});
