
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  listToolsForTenant,
  _clearToolCacheForTests,
} from "../../../services/mcp/discovery";
import { READ_BASELINE, MESSAGING_BASELINE } from "../../../services/mcp/write-allowlist";

function withoutBaseline(names: string[]): string[] {
  return names.filter(
    (n) => !READ_BASELINE.has(n) && !MESSAGING_BASELINE.has(n),
  );
}

vi.mock("../../../services/supabase", () => {
  return {
    serviceClient: vi.fn(),
  };
});

import { serviceClient } from "../../../services/supabase";

const TENANT = "11111111-1111-1111-1111-111111111111";

type Row = {
  tenant_id: string;
  server_id: string;
  transport: "internal";
  url: null;
  command: null;
  args: null;
  enabled: boolean;
};

function row(server_id: string, enabled = true): Row {
  return {
    tenant_id: TENANT,
    server_id,
    transport: "internal",
    url: null,
    command: null,
    args: null,
    enabled,
  };
}

function stubTenantServers(rows: Row[]): void {
  (serviceClient as unknown as { mockReturnValue: (v: unknown) => void }).mockReturnValue({
    from: (_table: string) => ({
      select: (_cols: string) => ({
        eq: (_col1: string, _val1: string) => ({
          eq: (_col2: string, _val2: unknown) => Promise.resolve({ data: rows, error: null }),
        }),
      }),
    }),
  });
}

describe("mcp/discovery — meta_ads branch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _clearToolCacheForTests();
  });

  it("resolves meta_ads tools when tenant_mcp_servers row is enabled", async () => {
    stubTenantServers([row("meta_ads", true)]);
    const tools = await listToolsForTenant(TENANT, [
      "meta_ads__list_campaigns",
      "meta_ads__list_ad_sets",
    ]);
    const names = new Set(tools.map((t) => t.name));
    expect(names.has("meta_ads__list_campaigns")).toBe(true);
    expect(names.has("meta_ads__list_ad_sets")).toBe(true);
    const metaAds = [...names].filter((n) => n.startsWith("meta_ads__"));
    expect(metaAds.length).toBeGreaterThan(2);
  });

  it("keeps meta_ads GATED when no enabled tenant_mcp_servers row exists", async () => {
    stubTenantServers([]);
    const tools = await listToolsForTenant(TENANT, ["meta_ads__list_campaigns"]);
    const metaAds = tools.map((t) => t.name).filter((n) => n.startsWith("meta_ads__"));
    expect(metaAds).toEqual([]);
  });

  it("does not duplicate or drop sibling connectors (slack + github + meta_ads coexist)", async () => {
    stubTenantServers([row("slack"), row("github"), row("meta_ads")]);
    const tools = await listToolsForTenant(TENANT, [
      "slack__list_channels",
      "github__list_repos",
      "meta_ads__list_campaigns",
    ]);
    const allNames = tools.map((t) => t.name);
    const names = new Set(allNames);
    expect(names.has("meta_ads__list_campaigns")).toBe(true);
    expect(names.has("slack__list_channels")).toBe(true);
    expect(names.has("github__list_repos")).toBe(true);
    expect(allNames.length).toBe(names.size);
  });
});
