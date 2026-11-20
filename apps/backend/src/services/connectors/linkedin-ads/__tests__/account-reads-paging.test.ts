import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/services/connectors/core/token", () => ({ getConnectorToken: async () => "tok", forceRefreshConnector: vi.fn(), markConnectorTokenRevoked: vi.fn() }));

import { resetLinkedInAdsReadCache } from "../http";
import { readLinkedInCampaignTargetingWithToken, readLinkedInConversionsWithToken } from "../account-reads";

const ok = (body: unknown) => ({ ok: true, status: 200, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) });
const urls = () => m.fetch.mock.calls.map(([u]) => decodeURIComponent(String(u)));

beforeEach(() => {
  resetLinkedInAdsReadCache();
  m.fetch.mockReset();
  vi.stubGlobal("fetch", m.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("account reads page the way each LinkedIn resource does", () => {
  it("must catch: the conversions finder pages with start and count and reads past the first page, so a tag with more than one page of rules is not reported from its first few", async () => {
    const rows = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: from + i, enabled: true }));
    m.fetch.mockImplementation(async (url: unknown) => {
      const u = decodeURIComponent(String(url));
      const start = Number(/[?&]start=(\d+)/.exec(u)?.[1] ?? "x");
      if (!Number.isFinite(start) || !/[?&]count=100/.test(u)) return ok({ elements: rows(0, 10), paging: { start: 0, count: 10, total: 140 } });
      return ok({ elements: rows(start, start === 0 ? 100 : 40), paging: { start, count: 100, total: 140 } });
    });
    const out = await readLinkedInConversionsWithToken("tok", "11");
    expect(out).toHaveLength(140);
    expect(urls().map((u) => /start=(\d+)/.exec(u)?.[1])).toEqual(["0", "100"]);
    expect(urls().join(" ")).not.toMatch(/pageSize|pageToken/);
  });

  it("the campaign search pages with pageSize and pageToken", async () => {
    m.fetch.mockImplementation(async (url: unknown) => {
      const u = decodeURIComponent(String(url));
      if (!/pageSize=100/.test(u)) return ok({ elements: [] });
      return /pageToken=next/.test(u) ? ok({ elements: [{ id: 2 }], metadata: {} }) : ok({ elements: [{ id: 1 }], metadata: { nextPageToken: "next" } });
    });
    const out = await readLinkedInCampaignTargetingWithToken("tok", "11", ["ACTIVE"]);
    expect(out.map((c) => c.id)).toEqual([1, 2]);
    expect(urls().join(" ")).not.toMatch(/start=|count=/);
  });
});
