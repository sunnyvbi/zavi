import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/services/secrets/vault", () => ({
  getSecret: async (_t: string, key: string) => (key === "meta_ads.access_token" ? "tok" : "123"),
}));
vi.mock("@/../workers/client", () => ({ inngest: { send: async () => undefined } }));

import { fbGetAllPages } from "../_client";

const page = (ids: string[], after?: string, next = after != null) => ({
  data: ids.map((id) => ({ id })),
  ...(next ? { paging: { next: "https://graph.facebook.com/next", cursors: after ? { after } : {} } } : {}),
});
function mockPages(pages: unknown[]) {
  const spy = vi.spyOn(global, "fetch");
  for (const p of pages) spy.mockResolvedValueOnce(new Response(JSON.stringify(p), { status: 200 }));
  return spy;
}

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("fbGetAllPages", () => {
  it("follows the after cursor to the last page", async () => {
    const spy = mockPages([page(["1", "2"], "c1"), page(["3"])]);
    const rows = await fbGetAllPages<{ id: string }>("t1", "act_123/adsets", { fields: "id", limit: 2 });
    expect(rows.map((r) => r.id)).toEqual(["1", "2", "3"]);
    const urls = spy.mock.calls.map(([u]) => new URL(String(u)));
    expect(urls[0].searchParams.get("after")).toBeNull();
    expect(urls[1].searchParams.get("after")).toBe("c1");
    expect(urls[1].searchParams.get("fields")).toBe("id");
  });

  it("throws past the page limit instead of coming back short", async () => {
    mockPages([page(["1"], "c1"), page(["2"], "c2")]);
    await expect(fbGetAllPages("t2", "act_123/adsets", {}, 2)).rejects.toMatchObject({ code: "meta_ads_pagination_incomplete" });
  });

  it("throws on a next page without a cursor", async () => {
    mockPages([page(["1"], undefined, true)]);
    await expect(fbGetAllPages("t3", "act_123/adsets", {})).rejects.toMatchObject({ code: "meta_ads_pagination_incomplete" });
  });
});
