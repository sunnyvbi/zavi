
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  rpc: vi.fn(),
  ownedRow: null as { team_id: string } | null,
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.maybeSingle = async () => ({ data: mocks.ownedRow, error: null });
      return b;
    },
    rpc: mocks.rpc,
  }),
}));

import { setSlackWorkspaceMetaHandler } from "../slack-workspace-meta";

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

beforeEach(() => {
  mocks.requireAuth.mockReset();
  mocks.rpc.mockReset();
  mocks.requireAuth.mockResolvedValue({ tenant_id: "tnt-1" });
  mocks.rpc.mockResolvedValue({ error: null });
  mocks.ownedRow = { team_id: "T1" };
});

describe("setSlackWorkspaceMetaHandler", () => {
  it("400s a missing team_id and never writes", async () => {
    const res = mockRes();
    await setSlackWorkspaceMetaHandler({ body: { purpose: "support" } } as never, res as never);
    expect(res.statusCode).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("400s an invalid purpose", async () => {
    const res = mockRes();
    await setSlackWorkspaceMetaHandler(
      { body: { team_id: "T1", purpose: "marketing" } } as never,
      res as never,
    );
    expect(res.statusCode).toBe(400);
    expect((res.body as { error?: { code?: string } }).error?.code).toBe("invalid_purpose");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("400s a malformed default_agent_slug", async () => {
    const res = mockRes();
    await setSlackWorkspaceMetaHandler(
      { body: { team_id: "T1", default_agent_slug: "Bad Slug!" } } as never,
      res as never,
    );
    expect(res.statusCode).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("404s when the workspace doesn't belong to the caller's tenant — never writes", async () => {
    mocks.ownedRow = null;
    const res = mockRes();
    await setSlackWorkspaceMetaHandler(
      { body: { team_id: "T_FOREIGN", purpose: "dev" } } as never,
      res as never,
    );
    expect(res.statusCode).toBe(404);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("writes with p_tenant_id = auth.tenant_id (NOT a body-supplied tenant)", async () => {
    const res = mockRes();
    await setSlackWorkspaceMetaHandler(
      {
        body: {
          team_id: "T1",
          purpose: "support",
          label: "Support Slack",
          default_agent_slug: "support-lead",
          tenant_id: "tnt-EVIL",
          p_tenant_id: "tnt-EVIL",
        },
      } as never,
      res as never,
    );
    expect(res.statusCode).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "set_slack_workspace_meta",
      expect.objectContaining({
        p_tenant_id: "tnt-1",
        p_team_id: "T1",
        p_purpose: "support",
        p_label: "Support Slack",
        p_default_agent_slug: "support-lead",
      }),
    );
  });

  it("clears the default agent when default_agent_slug is empty string", async () => {
    const res = mockRes();
    await setSlackWorkspaceMetaHandler(
      { body: { team_id: "T1", default_agent_slug: "" } } as never,
      res as never,
    );
    expect(res.statusCode).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "set_slack_workspace_meta",
      expect.objectContaining({ p_default_agent_slug: "" }),
    );
  });
});
