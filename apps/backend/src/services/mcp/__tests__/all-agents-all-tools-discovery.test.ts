
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  serviceClientMock: vi.fn(),
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: mocks.serviceClientMock,
}));

import { discoverToolsForTenant, _clearToolCacheForTests } from "../discovery";

const UNDECLARED_INTERNAL = "operator_db__query";
const DECLARED = ["memory__search"];

const savedEnv = process.env.ALL_AGENTS_ALL_TOOLS;

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

afterEach(() => {
  if (savedEnv === undefined) delete process.env.ALL_AGENTS_ALL_TOOLS;
  else process.env.ALL_AGENTS_ALL_TOOLS = savedEnv;
});

describe("ALL_AGENTS_ALL_TOOLS discovery bypass", () => {
  it("keeps paid specialists on their platform even with broad discovery enabled", async () => {
    process.env.ALL_AGENTS_ALL_TOOLS = "1";
    mocks.serviceClientMock.mockReturnValue({
      from: (table: string) => {
        const data = table === "tenant_mcp_servers"
          ? ["google_ads", "meta_ads"].map((server_id) => ({
              tenant_id: "t-1", server_id, transport: "internal", enabled: true,
            }))
          : [];
        const chain: Record<string, unknown> = {};
        for (const method of ["select", "eq", "in", "is", "order", "limit"]) chain[method] = () => chain;
        chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data, error: null }).then(resolve);
        return chain;
      },
    });
    const specialist = await discoverToolsForTenant("t-1", DECLARED, "chatgpt_ads");
    const names = specialist.tools.map((t) => t.name);
    expect(names).toContain("chatgpt_ads__read_performance");
    expect(names).toContain("growth__read_business_controls");
    expect(names).not.toContain("growth__read_ads_perf");
    expect(names).toContain("web_fetch__fetch");
    for (const platform of ["google_ads", "meta_ads", "reddit_ads", "tiktok_ads"]) {
      expect(specialist.tools.some((t) => t.server_id === platform)).toBe(false);
    }
    const operator = await discoverToolsForTenant("t-1", DECLARED, "operator");
    expect(operator.tools.map((t) => t.name)).toContain("google_ads__list_campaigns");
    expect(operator.tools.map((t) => t.name)).toContain("meta_ads__list_campaigns");
    expect(operator.tools.map((t) => t.name)).toContain("growth__read_ads_perf");
  });

  it("flag ON (default): an agent resolves an internal tool it never declared", async () => {
    delete process.env.ALL_AGENTS_ALL_TOOLS;
    const res = await discoverToolsForTenant("t-1", DECLARED);
    const names = res.tools.map((t) => t.name);
    expect(names).toContain(UNDECLARED_INTERNAL);
    expect(names).toContain("memory__search");
  });

  it("flag =0: the same agent does NOT resolve the undeclared internal tool", async () => {
    process.env.ALL_AGENTS_ALL_TOOLS = "0";
    const res = await discoverToolsForTenant("t-1", DECLARED);
    const names = res.tools.map((t) => t.name);
    expect(names).not.toContain(UNDECLARED_INTERNAL);
    expect(names).toContain("memory__search");
  });

  it("flag ON advertises strictly more tools than flag =0", async () => {
    process.env.ALL_AGENTS_ALL_TOOLS = "0";
    const off = await discoverToolsForTenant("t-1", DECLARED);
    _clearToolCacheForTests();
    delete process.env.ALL_AGENTS_ALL_TOOLS;
    const on = await discoverToolsForTenant("t-1", DECLARED);
    expect(on.tools.length).toBeGreaterThan(off.tools.length);
  });
});
