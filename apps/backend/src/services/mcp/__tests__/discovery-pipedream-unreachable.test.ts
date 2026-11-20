import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  listed: [] as string[],
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      const data = table === "tenant_mcp_servers" ? m.rows
        : table === "connector_metadata" ? [{ slug: "composio.gmail" }] : [];
      const q: any = {
        select: () => q, eq: () => q, like: () => q, in: () => q, order: () => q, limit: () => q,
        maybeSingle: async () => ({ data: table === "tenant_mcp_servers" ? (m.rows[0] ?? null) : null, error: null }),
        then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
          Promise.resolve({ data, error: null }).then(ok, bad),
      };
      return q;
    },
  }),
}));
vi.mock("../streamable-client", async (orig) => ({
  ...(await orig<typeof import("../streamable-client")>()),
  listStreamableTools: vi.fn(async (_tenant: string, s: { server_id: string }) => {
    m.listed.push(s.server_id);
    return [];
  }),
}));

import { getEnabledStreamableServer, discoverToolsForTenant } from "../discovery";

const row = (server_id: string, url: string) => ({
  tenant_id: "t", server_id, transport: "streamable-http", url, command: null, args: [], enabled: true,
});

beforeEach(() => { m.rows = []; m.listed = []; });

describe("Pipedream is unreachable", () => {
  it("getEnabledStreamableServer returns null for an enabled, well-formed pipedream_* row", async () => {
    m.rows = [row("pipedream_gmail", "https://remote.mcp.pipedream.net")];
    expect(await getEnabledStreamableServer("t", "pipedream_gmail")).toBeNull();
  });

  it("getEnabledStreamableServer still routes a composio row", async () => {
    m.rows = [row("composio", "https://backend.composio.dev/v3/mcp/srv?user_id=t")];
    expect((await getEnabledStreamableServer("t", "composio"))?.server_id).toBe("composio");
  });

  it("discovery never lists a pipedream_* server, even when the agent declares it", async () => {
    m.rows = [
      row("pipedream_gmail", "https://remote.mcp.pipedream.net"),
      row("composio", "https://backend.composio.dev/v3/mcp/srv?user_id=t"),
    ];
    await discoverToolsForTenant("t", ["pipedream_*__*", "pipedream_gmail__*", "composio__*"]);
    expect(m.listed).toContain("composio");
    expect(m.listed).not.toContain("pipedream_gmail");
  });
});
