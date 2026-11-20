
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ serviceClientMock: vi.fn() }));
vi.mock("@/services/supabase", () => ({ serviceClient: mocks.serviceClientMock }));

import { discoverToolsForTenant, _clearToolCacheForTests } from "../discovery";
import { MESSAGING_BASELINE } from "../write-allowlist";

const MSG = [...MESSAGING_BASELINE];

function mockServers(rows: unknown[]) {
  mocks.serviceClientMock.mockReturnValue({
    from: () => ({
      select: () => ({
        eq: () => ({ eq: () => Promise.resolve({ data: rows, error: null }) }),
      }),
    }),
  });
}

beforeEach(() => _clearToolCacheForTests());

describe("messaging-baseline discovery — universal when Slack connected", () => {
  it("a ZERO-slack-frontmatter agent resolves ALL 4 messaging tools when Slack is connected", async () => {
    mockServers([
      { tenant_id: "t-1", server_id: "slack", transport: "internal", enabled: true },
    ]);
    const res = await discoverToolsForTenant("t-1", ["memory__search"]);
    const names = res.tools.map((t) => t.name);
    for (const m of MSG) {
      expect(names, `messaging tool ${m} must resolve for a zero-slack agent`).toContain(m);
    }
  });

  it("does NOT grant messaging tools when Slack is NOT connected", async () => {
    mockServers([]);
    const res = await discoverToolsForTenant("t-1", ["memory__search"]);
    const names = res.tools.map((t) => t.name);
    for (const m of MSG) {
      expect(names, `messaging tool ${m} must NOT resolve without slack`).not.toContain(m);
    }
  });

  it("does NOT flag slack disconnected merely because of the messaging baseline", async () => {
    mockServers([]);
    const res = await discoverToolsForTenant("t-1", ["memory__search"]);
    expect(res.disconnected_connectors).not.toContain("slack");
  });

  it("(2026-06-29) Slack READ tools are now universal too — a zero-slack-frontmatter agent resolves them when connected", async () => {
    mockServers([
      { tenant_id: "t-1", server_id: "slack", transport: "internal", enabled: true },
    ]);
    const res = await discoverToolsForTenant("t-1", ["memory__search"]);
    const names = res.tools.map((t) => t.name);
    expect(names).toContain("slack__list_channels");
    expect(names).toContain("slack__get_reactions");
    expect(names).toContain("slack__read_thread");
    for (const m of MSG) expect(names).toContain(m);
  });

  it("Slack reads do NOT resolve when slack is NOT connected", async () => {
    mockServers([]);
    const res = await discoverToolsForTenant("t-1", ["memory__search"]);
    const names = res.tools.map((t) => t.name);
    expect(names).not.toContain("slack__list_channels");
    expect(names).not.toContain("slack__get_reactions");
  });
});
