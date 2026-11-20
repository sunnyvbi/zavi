
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  serviceClientMock: vi.fn(),
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: mocks.serviceClientMock,
}));

import { discoverToolsForTenant, _clearToolCacheForTests } from "../discovery";
import { READ_BASELINE } from "../write-allowlist";

const BASELINE = [...READ_BASELINE];

beforeEach(() => {
  _clearToolCacheForTests();
  mocks.serviceClientMock.mockReturnValue({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => Promise.resolve({ data: [], error: null }),
        }),
      }),
    }),
  });
});

describe("E-2 discovery — READ_BASELINE always resolves", () => {
  it("an agent with a normal declared set ALSO gets the baseline read tools", async () => {
    const res = await discoverToolsForTenant("t-1", ["memory__search"]);
    const names = res.tools.map((t) => t.name);
    expect(names).toContain("memory__search");
    for (const b of BASELINE) {
      expect(names, `baseline ${b} must resolve`).toContain(b);
    }
  });

  it("an agent with ZERO declared tools STILL resolves the baseline (early-return fix)", async () => {
    const res = await discoverToolsForTenant("t-1", []);
    const names = res.tools.map((t) => t.name);
    expect(names.length).toBeGreaterThan(0);
    for (const b of BASELINE) {
      expect(names, `baseline ${b} must resolve for a zero-declared agent`).toContain(b);
    }
  });

  it("baseline tools never appear in disconnected_connectors", async () => {
    const res = await discoverToolsForTenant("t-1", ["github__list_repos"]);
    expect(res.disconnected_connectors).toContain("github");
    expect(res.disconnected_connectors).not.toContain("web_search");
    expect(res.disconnected_connectors).not.toContain("web_fetch");
    expect(res.disconnected_connectors).not.toContain("apify");
    const res2 = await discoverToolsForTenant("t-1", ["slack__list_channels"]);
    expect(res2.disconnected_connectors).not.toContain("slack");
  });

  it("no duplicate baseline tool when the agent already declared it", async () => {
    const res = await discoverToolsForTenant("t-1", ["web_search__search"]);
    const names = res.tools.map((t) => t.name);
    expect(names.filter((n) => n === "web_search__search")).toHaveLength(1);
  });
});
