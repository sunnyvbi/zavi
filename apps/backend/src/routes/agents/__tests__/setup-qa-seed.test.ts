
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  getAgentSetupSchema: vi.fn(),
  probeSetupCompleteness: vi.fn(),
  enqueueAgentRun: vi.fn(),
  rpc: vi.fn(),
  tenantUserResult: { data: { role: "owner" }, error: null } as unknown,
  testCasesCount: { count: 0, error: null } as unknown,
  inflightRuns: { data: [], error: null } as unknown,
  inflightFilters: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: mocks.requireAuth,
}));
vi.mock("@/services/agents/setup-schema", () => ({
  getAgentSetupSchema: mocks.getAgentSetupSchema,
  probeSetupCompleteness: mocks.probeSetupCompleteness,
}));
vi.mock("@/services/agents/runner", () => ({
  enqueueAgentRun: mocks.enqueueAgentRun,
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    rpc: mocks.rpc,
    from: (table: string) => {
      if (table === "tenant_users") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({ maybeSingle: async () => mocks.tenantUserResult }),
            }),
          }),
        };
      }
      if (table === "test_cases") {
        return {
          select: () => ({ eq: async () => mocks.testCasesCount }),
        };
      }
      if (table === "agent_runs") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                in: () => ({
                  contains: (col: string, val: Record<string, unknown>) => {
                    mocks.inflightFilters.push({ col, val });
                    return { limit: async () => mocks.inflightRuns };
                  },
                }),
              }),
            }),
          }),
        };
      }
      if (table === "agent_setup_state") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({ maybeSingle: async () => ({ data: null }) }),
            }),
          }),
          delete: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

import { agentSetupPost } from "../setup";

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

const QA_SCHEMA = {
  rationale: "qa setup",
  vault_keys: [
    { key: "qa.staging_url", label: "Staging URL", input: "url", required: true },
    { key: "qa.guest.email", label: "Guest email", input: "email", required: false },
    { key: "qa.guest.password", label: "Guest password", input: "password", required: false },
  ],
  connectors: [],
  optional_connectors: [],
};

function makeReq(slug: string, vault: Record<string, string>) {
  return {
    params: { slug },
    body: { vault, retry: false },
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.inflightFilters = [];
  mocks.requireAuth.mockResolvedValue({ user_id: "u1", tenant_id: "t1" });
  mocks.getAgentSetupSchema.mockResolvedValue(QA_SCHEMA);
  mocks.rpc.mockResolvedValue({ error: null });
  mocks.tenantUserResult = { data: { role: "owner" }, error: null };
  mocks.testCasesCount = { count: 0, error: null };
  mocks.inflightRuns = { data: [], error: null };
  mocks.enqueueAgentRun.mockResolvedValue({ run_id: "run-seed-1" });
});

describe("agentSetupPost — qa catalog-build seed (P0-3)", () => {
  it("first staging-URL save + zero test cases → enqueues ONE catalog-build run", async () => {
    const res = mockRes();
    await agentSetupPost(
      makeReq("qa", { "qa.staging_url": "https://staging.example.com" }),
      res as never,
    );
    expect(res.statusCode).toBe(200);
    expect(mocks.enqueueAgentRun).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueAgentRun).toHaveBeenCalledWith({
      agent_slug: "qa",
      tenant_id: "t1",
      trigger: "webhook",
      payload: {
        mode: "catalog-build",
        source: "qa-setup",
        staging_url: "https://staging.example.com",
      },
    });
    expect((res.body as { catalog_seed: { run_id: string } }).catalog_seed).toEqual({
      run_id: "run-seed-1",
    });
    expect(mocks.inflightFilters).toEqual([
      { col: "payload", val: { mode: "catalog-build" } },
    ]);
  });

  it("IDEMPOTENT — tenant already has test cases → no enqueue", async () => {
    mocks.testCasesCount = { count: 17, error: null };
    const res = mockRes();
    await agentSetupPost(
      makeReq("qa", { "qa.staging_url": "https://staging.example.com" }),
      res as never,
    );
    expect(res.statusCode).toBe(200);
    expect(mocks.enqueueAgentRun).not.toHaveBeenCalled();
    expect((res.body as { catalog_seed: unknown }).catalog_seed).toBeNull();
  });

  it("double-submit guard — in-flight catalog-build run → no second enqueue", async () => {
    mocks.inflightRuns = { data: [{ id: "run-prior" }], error: null };
    const res = mockRes();
    await agentSetupPost(
      makeReq("qa", { "qa.staging_url": "https://staging.example.com" }),
      res as never,
    );
    expect(res.statusCode).toBe(200);
    expect(mocks.enqueueAgentRun).not.toHaveBeenCalled();
    expect((res.body as { catalog_seed: unknown }).catalog_seed).toBeNull();
  });

  it("saving only optional creds (no staging_url) → no seed probe, no enqueue", async () => {
    const res = mockRes();
    await agentSetupPost(
      makeReq("qa", { "qa.guest.email": "qa@example.com" }),
      res as never,
    );
    expect(res.statusCode).toBe(200);
    expect(mocks.enqueueAgentRun).not.toHaveBeenCalled();
    expect((res.body as { catalog_seed: unknown }).catalog_seed).toBeNull();
  });

  it("non-qa slug never seeds even if a same-named key is written", async () => {
    mocks.getAgentSetupSchema.mockResolvedValue({
      ...QA_SCHEMA,
      vault_keys: [
        { key: "qa.staging_url", label: "x", input: "url", required: false },
      ],
    });
    const res = mockRes();
    await agentSetupPost(
      makeReq("operator", { "qa.staging_url": "https://staging.example.com" }),
      res as never,
    );
    expect(res.statusCode).toBe(200);
    expect(mocks.enqueueAgentRun).not.toHaveBeenCalled();
  });

  it("best-effort — enqueue failure does NOT fail the POST (vault writes already landed)", async () => {
    mocks.enqueueAgentRun.mockRejectedValue(new Error("fleet halted"));
    const res = mockRes();
    await agentSetupPost(
      makeReq("qa", { "qa.staging_url": "https://staging.example.com" }),
      res as never,
    );
    expect(res.statusCode).toBe(200);
    const body = res.body as { ok: boolean; wrote: string[]; catalog_seed: unknown };
    expect(body.ok).toBe(true);
    expect(body.wrote).toEqual(["qa.staging_url"]);
    expect(body.catalog_seed).toBeNull();
  });
});
