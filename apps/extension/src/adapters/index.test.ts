import { describe, expect, it, vi } from "vitest";
import { pickAdapter } from "./index";
import { metaAdsAdapter } from "./meta-ads";
import type { PageAdapter, WireExtraction } from "./types";

const FAKE: WireExtraction = {
  rows: [{ name: "Test campaign", level: "campaign" }],
  date_preset: null,
  account_name: null,
  truncated: false,
  row_count_total: 1,
};

function adapter(over: Partial<PageAdapter> = {}): PageAdapter {
  return {
    id: "test",
    schema_version: 1,
    matches: () => true,
    extract: () => FAKE,
    ...over,
  };
}

const doc = {} as Document;
const loc = { hostname: "example.com", pathname: "/a" };

describe("pickAdapter", () => {
  it("wraps an extraction with its adapter id and schema version", () => {
    const a = adapter({ id: "meta_ads", schema_version: 3 });
    expect(pickAdapter(loc, doc, [a])).toEqual({
      adapter_id: "meta_ads",
      schema_version: 3,
      extraction: FAKE,
    });
  });

  it("returns null when no adapter claims the host", () => {
    expect(pickAdapter(loc, doc, [adapter({ matches: () => false })])).toBeNull();
  });

  it("returns null when the adapter claims the host but cannot read it", () => {
    expect(pickAdapter(loc, doc, [adapter({ extract: () => null })])).toBeNull();
  });

  it("returns null when extract() throws", () => {
    const a = adapter({
      extract: () => {
        throw new Error("selector gone");
      },
    });
    expect(pickAdapter(loc, doc, [a])).toBeNull();
  });

  it("skips an adapter whose matcher throws instead of failing the capture", () => {
    const bad = adapter({
      id: "bad",
      matches: () => {
        throw new Error("bad matcher");
      },
    });
    expect(pickAdapter(loc, doc, [bad, adapter({ id: "good" })])).toMatchObject({
      adapter_id: "good",
    });
  });

  it("stops at the first claiming adapter", () => {
    const second = adapter({ id: "second" });
    const spy = vi.spyOn(second, "extract");
    expect(pickAdapter(loc, doc, [adapter({ id: "first" }), second])).toMatchObject(
      { adapter_id: "first" },
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns observation mode for an ordinary page against the REAL registry", () => {
    expect(pickAdapter({ hostname: "news.ycombinator.com", pathname: "/" }, doc)).toBeNull();
  });
});

describe("metaAdsAdapter", () => {
  it("claims Ads Manager", () => {
    expect(
      metaAdsAdapter.matches({
        hostname: "adsmanager.facebook.com",
        pathname: "/adsmanager/manage/campaigns",
      }),
    ).toBe(true);
  });

  it("claims the Business Suite ads surfaces", () => {
    expect(
      metaAdsAdapter.matches({
        hostname: "business.facebook.com",
        pathname: "/latest/ad_center/all_ads",
      }),
    ).toBe(true);
  });

  it("does NOT claim someone's Facebook feed", () => {
    expect(metaAdsAdapter.matches({ hostname: "www.facebook.com", pathname: "/" })).toBe(
      false,
    );
    expect(
      metaAdsAdapter.matches({ hostname: "www.facebook.com", pathname: "/marketplace" }),
    ).toBe(false);
  });

  it("does NOT claim an unrelated host", () => {
    expect(metaAdsAdapter.matches({ hostname: "example.com", pathname: "/adsmanager" })).toBe(
      false,
    );
  });

  it("returns a wire-shaped extraction on a Meta page, not null", () => {
    const out = metaAdsAdapter.extract(doc);
    expect(out).not.toBeNull();
    expect(Object.keys(out ?? {}).sort()).toEqual([
      "account_name",
      "date_preset",
      "row_count_total",
      "rows",
      "truncated",
    ]);
  });

  it("reports zero rows, not a guess, when the page has no ads grid", () => {
    const out = metaAdsAdapter.extract(doc) as { rows: unknown[]; row_count_total: number };
    expect(out.rows).toEqual([]);
    expect(out.row_count_total).toBe(0);
  });
});
