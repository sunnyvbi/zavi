
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  rpcCalls: [] as Array<{ name: string; args: unknown }>,
  auditCalls: [] as unknown[],
}));

vi.mock("@/services/auth/staff-middleware", () => ({
  assertStaff: () => ({ user_id: "u1", email: "ravi@upcar.ai" }),
}));

vi.mock("@/services/supabase", () => {
  const tenantsQ: Record<string, unknown> = {
    select: () => tenantsQ,
    eq: () => tenantsQ,
    maybeSingle: () => ({ data: { id: "t" }, error: null }),
  };
  return {
    serviceClient: () => ({
      from: () => tenantsQ,
      rpc: (name: string, args: unknown) => {
        h.rpcCalls.push({ name, args });
        return { data: null, error: null };
      },
    }),
  };
});

vi.mock("@/services/staff/audit", () => ({
  writeStaffAudit: async (x: unknown) => {
    h.auditCalls.push(x);
  },
}));

vi.mock("@/services/agents/registry", () => ({
  listAgents: () => [
    { slug: "pm", name: "PM", metadata_praxis: { model: "claude-opus-4-7" } },
    { slug: "support-lead", name: "Support", metadata_praxis: { model: "claude-opus-4-7" } },
    { slug: "research", name: "Research", metadata_praxis: { model: "claude-opus-4-7" } },
  ],
}));

vi.mock("@/services/agents/engine/pick-engine", () => ({
  pickProvider: () => "anthropic",
}));

import { staffEngineOverrideSet } from "../engine-override";

const TID = "73db45ff-457e-4541-bc8f-bdb625390204";

function mockRes() {
  const res: { statusCode: number; body: unknown; status: (c: number) => typeof res; json: (b: unknown) => typeof res } = {
    statusCode: 200,
    body: undefined,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
  return res;
}

describe("staffEngineOverrideSet — stateless-first bedrock guard", () => {
  beforeEach(() => {
    h.rpcCalls = [];
    h.auditCalls = [];
  });

  it("REJECTS bedrock for a conversational agent (pm) with 400, no RPC call", async () => {
    const res = mockRes();
    await staffEngineOverrideSet(
      {
        body: {
          tenant_id: TID,
          agent_slug: "pm",
          provider: "bedrock",
          model: "qwen.qwen3-next-80b-a3b-instruct",
        },
      } as never,
      res as never,
    );
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe(
      "bedrock_conversational_unsupported",
    );
    expect(h.rpcCalls.filter((c) => c.name === "set_tenant_agent_provider")).toHaveLength(0);
    expect(h.auditCalls).toHaveLength(0);
  });

  it("REJECTS bedrock for support-lead too", async () => {
    const res = mockRes();
    await staffEngineOverrideSet(
      {
        body: {
          tenant_id: TID,
          agent_slug: "support-lead",
          provider: "bedrock",
          model: "qwen.qwen3-next-80b-a3b-instruct",
        },
      } as never,
      res as never,
    );
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe(
      "bedrock_conversational_unsupported",
    );
  });

  it("ALLOWS bedrock for a STATELESS agent (research) → reaches the set RPC", async () => {
    const res = mockRes();
    await staffEngineOverrideSet(
      {
        body: {
          tenant_id: TID,
          agent_slug: "research",
          provider: "bedrock",
          model: "qwen.qwen3-next-80b-a3b-instruct",
        },
      } as never,
      res as never,
    );
    expect(res.statusCode).toBe(200);
    expect(h.rpcCalls.filter((c) => c.name === "set_tenant_agent_provider")).toHaveLength(1);
  });

  it("does NOT block an anthropic override for a conversational agent (guard is bedrock-only)", async () => {
    const res = mockRes();
    await staffEngineOverrideSet(
      {
        body: {
          tenant_id: TID,
          agent_slug: "pm",
          provider: "anthropic",
          model: "claude-opus-4-7",
        },
      } as never,
      res as never,
    );
    expect(res.statusCode).toBe(200);
    expect(h.rpcCalls.filter((c) => c.name === "set_tenant_agent_provider")).toHaveLength(1);
  });
});
