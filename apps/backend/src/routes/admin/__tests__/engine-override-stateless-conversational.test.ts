
import { describe, it, expect, vi, beforeEach } from "vitest";
import { STATELESS_PROVIDERS } from "@/services/llm/models";

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
    { slug: "advisor", name: "Advisor", metadata_praxis: { model: "claude-opus-4-7" } },
    { slug: "research", name: "Research", metadata_praxis: { model: "claude-opus-4-7" } },
  ],
}));

vi.mock("@/services/agents/engine/pick-engine", () => ({
  pickProvider: () => "anthropic",
}));

import { staffEngineOverrideSet } from "../engine-override";

const TID = "73db45ff-457e-4541-bc8f-bdb625390204";

const MODEL_FOR: Record<string, string> = {
  bedrock: "qwen.qwen3-next-80b-a3b-instruct",
  fireworks: "accounts/fireworks/models/glm-5p2",
  langchain: "claude-sonnet-4-6",
};

function mockRes() {
  const res: {
    statusCode: number;
    body: unknown;
    status: (c: number) => typeof res;
    json: (b: unknown) => typeof res;
  } = {
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

async function attemptSet(agent_slug: string, provider: string, model: string) {
  const res = mockRes();
  await staffEngineOverrideSet(
    { body: { tenant_id: TID, agent_slug, provider, model } } as never,
    res as never,
  );
  return res;
}

describe("staffEngineOverrideSet — write seam matches resolver for stateless providers", () => {
  beforeEach(() => {
    h.rpcCalls = [];
    h.auditCalls = [];
  });

  it("REJECTS fireworks for a conversational agent (pm), and never reaches the RPC", async () => {
    const res = await attemptSet("pm", "fireworks", MODEL_FOR.fireworks);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe(
      "fireworks_conversational_unsupported",
    );
    expect(
      h.rpcCalls.filter((c) => c.name === "set_tenant_agent_provider"),
    ).toHaveLength(0);
    expect(h.auditCalls).toHaveLength(0);
  });

  it.each([...STATELESS_PROVIDERS])(
    "provider %s is rejected at the WRITE seam for every conversational agent",
    async (provider) => {
      const model = MODEL_FOR[provider];
      expect(
        model,
        `no test model registered for stateless provider "${provider}" — add one to MODEL_FOR`,
      ).toBeTruthy();

      for (const slug of ["pm", "advisor"]) {
        h.rpcCalls = [];
        const res = await attemptSet(slug, provider, model);
        expect(
          res.statusCode,
          `${provider} + ${slug} must be rejected at the write seam (the resolver ignores it, so accepting it makes the admin GET report a provider that never runs)`,
        ).toBe(400);
        expect(
          h.rpcCalls.filter((c) => c.name === "set_tenant_agent_provider"),
        ).toHaveLength(0);
      }
    },
  );

  it("still ALLOWS a stateless provider on a STATELESS agent (research)", async () => {
    const res = await attemptSet("research", "fireworks", MODEL_FOR.fireworks);
    expect(res.statusCode).toBe(200);
    expect(
      h.rpcCalls.filter((c) => c.name === "set_tenant_agent_provider"),
    ).toHaveLength(1);
  });

  it("still ALLOWS anthropic on a conversational agent (guard is stateless-only)", async () => {
    const res = await attemptSet("pm", "anthropic", "claude-opus-4-7");
    expect(res.statusCode).toBe(200);
    expect(
      h.rpcCalls.filter((c) => c.name === "set_tenant_agent_provider"),
    ).toHaveLength(1);
  });
});
