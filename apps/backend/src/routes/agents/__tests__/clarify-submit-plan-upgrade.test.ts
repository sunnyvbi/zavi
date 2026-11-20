
import { describe, it, expect, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpcResult: { data: null as unknown, error: null as unknown },
}));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: async () => ({ tenant_id: "t1", user_id: "u1", access_token: "tok" }),
}));
vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({ rpc: async () => mocks.rpcResult }),
  serviceClient: () => ({}),
}));
vi.mock("@/services/agents/registry", () => ({
  loadAgentDefinition: async () => ({ slug: "engineer", content_hash: "h" }),
}));
vi.mock("@/../workers/client", () => ({ inngest: { send: vi.fn() } }));
vi.mock("@/services/agents/run-lane", () => ({ buildRunRequestedEvent: vi.fn() }));

import { agentClarifySubmit } from "../clarify-submit";

function mockRes() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
  };
}

const REQ = {
  params: { slug: "engineer" },
  body: { request_id: "3f1c2a4e-9b7d-4c1a-8e2f-5d6b7a8c9e01", answers: [] },
};

describe("clarify-submit tier refusal", () => {
  it("plan_upgrade_required from the RPC → 403 with required_tier", async () => {
    mocks.rpcResult = {
      data: null,
      error: { code: "P0001", message: "plan_upgrade_required", details: "pro" },
    };
    const res = mockRes();
    await agentClarifySubmit(REQ as never, res as never);
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({
      error: {
        code: "plan_upgrade_required",
        required_tier: "pro",
        message: "Engineer needs the Pro plan ($240/mo).",
      },
    });
  });

  it("an unrelated RPC error still maps to 500", async () => {
    mocks.rpcResult = { data: null, error: { code: "XX000", message: "boom" } };
    const res = mockRes();
    await agentClarifySubmit(REQ as never, res as never);
    expect(res.statusCode).toBe(500);
  });
});
