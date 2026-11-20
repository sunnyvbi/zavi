
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  mintInstallationToken: vi.fn(async () => "ghs_faketoken"),
  ghInstallationHeaders: vi.fn(() => ({ authorization: "Bearer ghs_faketoken" })),
  serviceClientMock: vi.fn(),
}));

vi.mock("@/services/connectors/github/oauth", () => ({
  mintInstallationToken: mocks.mintInstallationToken,
  ghInstallationHeaders: mocks.ghInstallationHeaders,
}));
vi.mock("@/services/supabase", () => ({ serviceClient: mocks.serviceClientMock }));

import { searchCodeImpl } from "../github";

const GITHUB_RANKING = [
  { name: "2026-09-11-cohost-earnings-split.md", path: "docs/superpowers/plans/2026-09-11-cohost-earnings-split.md" },
  { name: "cohost-earnings-split-spec.md", path: "docs/superpowers/specs/2026-09-11-cohost-earnings-split-spec.md" },
  { name: "splitMath.ts", path: "apps/backend/src/services/cohostSplit/splitMath.ts" },
  { name: "resolveSplits.ts", path: "apps/backend/src/services/cohostSplit/resolveSplits.ts" },
];

function stubSearch(items: Array<{ name: string; path: string }>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        total_count: items.length,
        items: items.map((i) => ({
          ...i,
          html_url: `https://github.com/o/r/blob/sha/${i.path}`,
          text_matches: [{ fragment: "cohost earnings" }],
        })),
      }),
      text: async () => "",
      headers: new Headers(),
    })) as unknown as typeof fetch,
  );
}

describe("search_code puts source above prose", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("ranks implementation files above docs even when GitHub ranked the doc first", async () => {
    stubSearch(GITHUB_RANKING);
    const out = await searchCodeImpl("t1", 1, {
      owner: "o", repo: "r", query: "cohost earnings", per_page: 10,
    } as never);

    expect(out.items[0].path).toMatch(/splitMath\.ts$/);
    expect(out.items.map((i: { path: string }) => i.path).slice(-2).every((p: string) => p.endsWith(".md"))).toBe(true);
    expect(out.source_hits).toBe(2);
    expect(out.doc_hits).toBe(2);
  });

  it("drops nothing — a docs-native agent still receives every hit", async () => {
    stubSearch(GITHUB_RANKING);
    const out = await searchCodeImpl("t1", 1, {
      owner: "o", repo: "r", query: "cohost earnings", per_page: 10,
    } as never);
    expect(out.items).toHaveLength(GITHUB_RANKING.length);
    for (const original of GITHUB_RANKING) {
      expect(out.items.some((i: { path: string }) => i.path === original.path)).toBe(true);
    }
  });

  it("says so plainly when EVERY hit is a doc — the shape that caused the incident", async () => {
    stubSearch(GITHUB_RANKING.filter((i) => i.path.endsWith(".md")));
    const out = await searchCodeImpl("t1", 1, {
      owner: "o", repo: "r", query: "cohost earnings", per_page: 10,
    } as never);
    expect(out.source_hits).toBe(0);
    expect(out.ordering_note).toMatch(/Every hit is a doc/);
    expect(out.ordering_note).toMatch(/INTENT, not shipped behaviour/);
  });

  it("stays quiet when there is nothing to disambiguate", async () => {
    stubSearch(GITHUB_RANKING.filter((i) => i.path.endsWith(".ts")));
    const out = await searchCodeImpl("t1", 1, {
      owner: "o", repo: "r", query: "computeShares", per_page: 10,
    } as never);
    expect(out.doc_hits).toBe(0);
    expect(out.ordering_note).toBeUndefined();
  });
});
