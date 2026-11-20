
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const H = vi.hoisted(() => ({
  authReturn: null as { user_id: string; tenant_id: string; access_token: string } | null,
  tuRow: null as { role: string } | null,
  setupSchema: null as Record<string, unknown> | null,
  setupStateRow: null as { blocked_run_id: string | null } | null,
  prevRunRow: null as { payload: unknown; trigger: string } | null,
  rpcCalls: [] as Array<{ fn: string; args: unknown }>,
  rpcResult: { error: null as { message: string } | null },
  deleteCalled: false,
  enqueueCalls: [] as unknown[],
  enqueueResult: { run_id: "new-run-id" } as { run_id: string },
  enqueueThrows: null as Error | null,
}));

function fromImpl(name: string) {
  if (name === "tenant_users") {
    return {
      select: () => ({
        eq: () => ({
          eq: () => ({ maybeSingle: () => Promise.resolve({ data: H.tuRow, error: null }) }),
        }),
      }),
    };
  }
  if (name === "agent_setup_state") {
    return {
      select: () => ({
        eq: () => ({
          eq: () => ({ maybeSingle: () => Promise.resolve({ data: H.setupStateRow, error: null }) }),
        }),
      }),
      delete: () => ({
        eq: () => ({
          eq: () => {
            H.deleteCalled = true;
            return Promise.resolve({ error: null });
          },
        }),
      }),
    };
  }
  if (name === "agent_runs") {
    return {
      select: () => ({
        eq: () => ({ maybeSingle: () => Promise.resolve({ data: H.prevRunRow, error: null }) }),
      }),
    };
  }
  throw new Error(`unexpected table ${name}`);
}

vi.mock("@/services/supabase", () => ({
  serviceClient: vi.fn(() => ({
    from: vi.fn(fromImpl),
    rpc: vi.fn(async (fn: string, args: unknown) => {
      H.rpcCalls.push({ fn, args });
      return H.rpcResult;
    }),
  })),
}));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async (_req: Request, res: Response) => {
    if (!H.authReturn) {
      res.status(401).json({ error: { code: "unauthenticated" } });
    }
    return H.authReturn;
  }),
}));

vi.mock("@/services/agents/setup-schema", () => ({
  getAgentSetupSchema: vi.fn(async () => H.setupSchema),
}));

vi.mock("@/services/agents/runner", () => ({
  enqueueAgentRun: vi.fn(async (args: unknown) => {
    H.enqueueCalls.push(args);
    if (H.enqueueThrows) throw H.enqueueThrows;
    return H.enqueueResult;
  }),
}));

import { agentSetupPost } from "../../routes/agents/setup";

function mockRes() {
  const body: { status?: number; json?: unknown } = {};
  return {
    status: vi.fn(function (this: unknown, s: number) {
      body.status = s;
      return this;
    }),
    json: vi.fn(function (j: unknown) {
      body.json = j;
      return j;
    }),
    _body: body,
  } as unknown as Response & { _body: typeof body };
}

beforeEach(() => {
  H.authReturn = { user_id: "u1", tenant_id: "t1", access_token: "tok" };
  H.tuRow = { role: "owner" };
  H.setupSchema = {
    rationale: "",
    vault_keys: [
      { key: "qa.staging_url", label: "URL", input: "url", required: true },
      { key: "qa.guest.email", label: "Email", input: "email", required: true },
      { key: "qa.host.email", label: "Host", input: "email", required: false },
    ],
    connectors: [],
  };
  H.setupStateRow = null;
  H.prevRunRow = null;
  H.rpcCalls.length = 0;
  H.rpcResult = { error: null };
  H.deleteCalled = false;
  H.enqueueCalls.length = 0;
  H.enqueueResult = { run_id: "new-run-id" };
  H.enqueueThrows = null;
});

const req = (params: Record<string, string>, body: unknown): Request =>
  ({ params, body }) as unknown as Request;

describe("POST /api/agents/:slug/setup", () => {
  it("rejects non-owner with 403 owner_only", async () => {
    H.tuRow = { role: "member" };
    const r = mockRes();
    await agentSetupPost(req({ slug: "qa-engineer-weekly" }, { vault: {}, retry: false }), r);
    expect(r._body.status).toBe(403);
    expect((r._body.json as { error: { code: string } }).error.code).toBe("owner_only");
  });

  it("rejects when user not a member of the tenant", async () => {
    H.tuRow = null;
    const r = mockRes();
    await agentSetupPost(req({ slug: "qa-engineer-weekly" }, { vault: {}, retry: false }), r);
    expect(r._body.status).toBe(403);
  });

  it("returns 404 when agent has no setup schema", async () => {
    H.setupSchema = null;
    const r = mockRes();
    await agentSetupPost(req({ slug: "no-such-agent" }, { vault: {}, retry: false }), r);
    expect(r._body.status).toBe(404);
  });

  it("rejects undeclared keys BEFORE any vault write (no partial mutation)", async () => {
    const r = mockRes();
    await agentSetupPost(
      req(
        { slug: "qa-engineer-weekly" },
        {
          vault: {
            "qa.staging_url": "https://x",
            "not.declared.key": "leak",
          },
          retry: false,
        },
      ),
      r,
    );
    expect(r._body.status).toBe(400);
    expect((r._body.json as { error: { code: string } }).error.code).toBe("undeclared_keys");
    expect(H.rpcCalls.length).toBe(0);
  });

  it("writes declared keys + clears state on success", async () => {
    const r = mockRes();
    await agentSetupPost(
      req(
        { slug: "qa-engineer-weekly" },
        {
          vault: {
            "qa.staging_url": "https://staging.example.com",
            "qa.guest.email": "qa@example.com",
          },
          retry: false,
        },
      ),
      r,
    );
    expect(r._body.status).toBeUndefined();
    expect(H.rpcCalls.length).toBe(2);
    expect(H.rpcCalls[0]).toMatchObject({
      fn: "set_agent_setup_secret",
      args: { p_tenant_id: "t1", p_agent_slug: "qa-engineer-weekly" },
    });
    expect(H.deleteCalled).toBe(true);
    expect((r._body.json as { ok: boolean }).ok).toBe(true);
  });

  it("strips empty optional fields (does not POST them to RPC)", async () => {
    const r = mockRes();
    await agentSetupPost(
      req(
        { slug: "qa-engineer-weekly" },
        {
          vault: {
            "qa.staging_url": "https://x",
            "qa.guest.email": "g@x",
            "qa.host.email": "",
          },
          retry: false,
        },
      ),
      r,
    );
    expect(H.rpcCalls.length).toBe(2);
    const keys = H.rpcCalls.map((c) => (c.args as { p_key: string }).p_key);
    expect(keys).not.toContain("qa.host.email");
  });

  it("on retry=true with blocked_run_id, reuses original payload + trigger", async () => {
    H.setupStateRow = { blocked_run_id: "blocked-run-1" };
    H.prevRunRow = { payload: { thread_id: "thr-1", original: true }, trigger: "chat" };
    const r = mockRes();
    await agentSetupPost(
      req(
        { slug: "qa-engineer-weekly" },
        {
          vault: { "qa.staging_url": "https://x", "qa.guest.email": "g@x" },
          retry: true,
        },
      ),
      r,
    );
    expect(H.enqueueCalls).toHaveLength(1);
    expect(H.enqueueCalls[0]).toMatchObject({
      agent_slug: "qa-engineer-weekly",
      tenant_id: "t1",
      trigger: "chat",
      payload: { thread_id: "thr-1", original: true },
    });
    expect((r._body.json as { retry: { ok: boolean; run_id: string } }).retry.run_id).toBe(
      "new-run-id",
    );
  });

  it("on retry=true with NO blocked row, falls back to manual + null payload", async () => {
    H.setupStateRow = null;
    const r = mockRes();
    await agentSetupPost(
      req(
        { slug: "qa-engineer-weekly" },
        {
          vault: { "qa.staging_url": "https://x", "qa.guest.email": "g@x" },
          retry: true,
        },
      ),
      r,
    );
    expect(H.enqueueCalls).toHaveLength(1);
    expect(H.enqueueCalls[0]).toMatchObject({
      trigger: "manual",
      payload: null,
    });
  });

  it("on retry failure, vault still written + retry.ok=false returned", async () => {
    H.enqueueThrows = new Error("kill switch");
    const r = mockRes();
    await agentSetupPost(
      req(
        { slug: "qa-engineer-weekly" },
        {
          vault: { "qa.staging_url": "https://x", "qa.guest.email": "g@x" },
          retry: true,
        },
      ),
      r,
    );
    expect(H.rpcCalls.length).toBe(2);
    expect(H.deleteCalled).toBe(true);
    const body = r._body.json as { ok: boolean; retry: { ok: boolean; error: string } };
    expect(body.ok).toBe(true);
    expect(body.retry.ok).toBe(false);
    expect(body.retry.error).toBe("kill switch");
  });

  it("returns 401 when unauthenticated", async () => {
    H.authReturn = null;
    const r = mockRes();
    await agentSetupPost(req({ slug: "qa-engineer-weekly" }, { vault: {}, retry: false }), r);
    expect(r._body.status).toBe(401);
  });
});
