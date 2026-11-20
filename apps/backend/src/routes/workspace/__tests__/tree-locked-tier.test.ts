
import type { Request, Response } from "express";
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({ rpcError: null as null | { message: string } }));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: async () => ({ tenant_id: "t-1", user_id: "u-1", access_token: "tok" }),
}));
vi.mock("@/services/agents/registry", () => ({
  listAgents: () => [
    { slug: "operator", metadata_praxis: { department: "leadership" } },
    { slug: "engineer", metadata_praxis: { department: "product" } },
  ],
}));
vi.mock("@/services/agents/visibility", () => ({ filterTenantVisibleAgents: async (a: unknown[]) => a }));
vi.mock("@/services/agents/custom-agents", () => ({ listCustomAgentsForTree: vi.fn(async () => []) }));
vi.mock("@/services/agents/thread-counts", () => ({ countThreadsBySlug: async () => new Map() }));
vi.mock("@/services/agents/entitlement", () => ({
  annotateLockedTier: async (a: Array<{ slug: string }>) =>
    a.map((x) => ({ ...x, locked_tier: x.slug === "engineer" ? "pro" : null })),
}));
vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({
    rpc: async () => (m.rpcError ? { data: null, error: m.rpcError } : { data: [], error: null }),
  }),
}));

import { workspaceTree } from "../tree";

function run() {
  let body: unknown = null;
  const res = {
    status: () => res,
    json: (b: unknown) => {
      body = b;
      return res;
    },
  } as unknown as Response;
  return workspaceTree({} as Request, res).then(() => body as { agents: Array<Record<string, unknown>> });
}

beforeEach(() => {
  m.rpcError = null;
});

describe("GET /api/workspace/tree — locked_tier", () => {
  it("keeps locked agents and sets locked_tier", async () => {
    const body = await run();
    expect(body.agents.map((a) => [a.slug, a.locked_tier])).toEqual([
      ["operator", null],
      ["engineer", "pro"],
    ]);
  });

  it("degraded response (RPC failed) carries locked_tier too", async () => {
    m.rpcError = { message: "boom" };
    const body = await run();
    expect(body.agents.find((a) => a.slug === "engineer")?.locked_tier).toBe("pro");
  });
});

describe("GET /api/workspace/tree: custom agents (Agent Builder)", () => {
  it("lists the tenant's active custom agents under their own names, marked custom", async () => {
    const { listCustomAgentsForTree } = await import("@/services/agents/custom-agents");
    vi.mocked(listCustomAgentsForTree).mockResolvedValueOnce([
      { id: "44444444-4444-4444-8444-444444444444", slug: "c-abc123def0", name: "Standup bot", locked_tier: null },
    ]);
    const body = await run();
    const row = body.agents.find((a) => a.slug === "c-abc123def0");
    expect(row).toMatchObject({
      name: "Standup bot",
      custom: true,
      custom_agent_id: "44444444-4444-4444-8444-444444444444",
      locked_tier: null,
      department: "others",
    });
    expect(body.agents.find((a) => a.slug === "operator")?.custom).toBeUndefined();
  });
});
