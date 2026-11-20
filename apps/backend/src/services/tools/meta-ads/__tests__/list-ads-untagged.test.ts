import { describe, it, expect, vi } from "vitest";

const fbGet = vi.fn();
vi.mock("../_client", async (original) => ({
  ...(await original<typeof import("../_client")>()),
  fbGet: (...a: unknown[]) => fbGet(...a),
  metaAdsCreds: async () => ({ ad_account_id: "act_77" }),
}));

import { readMetaAds, urlTagged } from "../list_ads";

describe("untagged live ads", () => {
  it("counts ACTIVE ads with no delivery yet, read from the ads themselves", async () => {
    fbGet.mockImplementation(async (_t: string, path: string) => {
      if (path === "act_77/insights") return { data: [{ ad_id: "a1", spend: "5" }] };
      if (path === "act_77/ads")
        return {
          data: [
            { id: "a1", effective_status: "ACTIVE", creative: { url_tags: "utm_source=meta" } },
            { id: "a2", effective_status: "ACTIVE", creative: { link_url: "https://florist.example/bouquets" } },
          ],
        };
      return { a1: { effective_status: "ACTIVE", creative: { url_tags: "utm_source=meta" } } };
    });
    const out = await readMetaAds("t", { since: "2026-10-01", until: "2026-10-07", include_creative: false });
    expect(out.untagged_live_ads).toEqual({ count: 1, of_live: 2, ad_ids: ["a2"], complete: true });
  });

  it("a failed ads read is unknown, never zero", async () => {
    fbGet.mockImplementation(async (_t: string, path: string) => {
      if (path === "act_77/ads") throw new Error("rate limited");
      if (path === "act_77/insights") return { data: [] };
      return {};
    });
    expect((await readMetaAds("t", { since: "2026-10-01", until: "2026-10-07", include_creative: false })).untagged_live_ads).toBeNull();
  });

  it("a video ad's click destination is read; one page of a bigger account is marked incomplete", async () => {
    expect(urlTagged({ object_story_spec: { video_data: { call_to_action: { value: { link: "https://florist.example/same-day" } } } } })).toBe(false);
    expect(
      urlTagged({ object_story_spec: { link_data: { link: "https://florist.example/?utm_source=fb", child_attachments: [{ link: "https://florist.example/roses?utm_source=fb" }, { link: "https://florist.example/tulips" }] } } }),
    ).toBe(false);
    fbGet.mockImplementation(async (_t: string, path: string) => {
      if (path === "act_77/insights") return { data: [] };
      if (path === "act_77/ads") return { data: [{ id: "a1", effective_status: "ACTIVE", creative: { url_tags: "utm_source=meta" } }], paging: { next: "cursor" } };
      return {};
    });
    expect((await readMetaAds("t", { since: "2026-10-01", until: "2026-10-07", include_creative: false })).untagged_live_ads).toMatchObject({ count: 0, complete: false });
  });

  it("a platform placeholder link (lead form, Messenger) has no site visit to tag", () => {
    expect(urlTagged({ link_url: "http://fb.me/" })).toBeNull();
    expect(urlTagged({ object_story_spec: { link_data: { link: "https://m.me/florist" } } })).toBeNull();
    expect(urlTagged({ link_url: "http://fb.me/", object_story_spec: { link_data: { link: "https://florist.example/" } } })).toBe(false);
  });
});
