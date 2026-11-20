import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({ serviceClientMock: vi.fn() }));
vi.mock("@/services/supabase", () => ({ serviceClient: mocks.serviceClientMock }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));

import { discoverToolsForTenant, _clearToolCacheForTests } from "../discovery";

function mockServers(rows: unknown[]) {
  mocks.serviceClientMock.mockReturnValue({
    from: () => ({ select: () => ({ eq: () => ({ eq: () => Promise.resolve({ data: rows, error: null }) }) }) }),
  });
}
const GEO = [
  "operator_db__query_bookings_by_geo_category",
  "operator_db__query_active_supply_by_geo_category",
  "operator_db__query_funnel_by_geo_category",
];

let prev: string | undefined;
beforeEach(() => {
  _clearToolCacheForTests();
  prev = process.env.ALL_AGENTS_ALL_TOOLS;
});
afterEach(() => {
  if (prev === undefined) delete process.env.ALL_AGENTS_ALL_TOOLS;
  else process.env.ALL_AGENTS_ALL_TOOLS = prev;
});

describe("per-agent tool hides", () => {
  it.each(["1", "0"])("operator never resolves the geo shortcuts, even declared (ALL_AGENTS_ALL_TOOLS=%s)", async (flag) => {
    process.env.ALL_AGENTS_ALL_TOOLS = flag;
    mockServers([{ server_id: "operator_db", transport: "internal", enabled: true }]);
    const res = await discoverToolsForTenant("t-1", ["operator_db__*", "growth__utilization_by_location"], "operator");
    const names = res.tools.map((t) => t.name);
    expect(names).toContain("operator_db__catalog");
    expect(names).toContain("growth__utilization_by_location");
    for (const g of GEO) expect(names).not.toContain(g);
  });

  it("another agent still resolves them", async () => {
    process.env.ALL_AGENTS_ALL_TOOLS = "1";
    mockServers([{ server_id: "operator_db", transport: "internal", enabled: true }]);
    const res = await discoverToolsForTenant("t-1", ["operator_db__*"], "pm");
    expect(res.tools.map((t) => t.name)).toEqual(expect.arrayContaining(GEO));
  });
});
