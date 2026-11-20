
import { describe, it, expect, vi, beforeEach } from "vitest";

const rpc = vi.fn();

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({ rpc }),
}));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: async () => ({
    user_id: "11111111-1111-4111-8111-111111111111",
    tenant_id: "22222222-2222-4222-8222-222222222222",
    access_token: "tok",
  }),
}));

const loadAgentDefinition = vi.fn(
  async (slug: string, _tenantId: string) => (slug === "nope" ? null : { slug }),
);
vi.mock("@/services/agents/registry", () => ({
  loadAgentDefinition: (slug: string, tenantId: string) =>
    loadAgentDefinition(slug, tenantId),
}));

import { agentListThreadsFeed } from "../list-threads-feed";

type Captured = { status: number; body: unknown };

function makeRes(): { res: any; captured: Captured } {
  const captured: Captured = { status: 200, body: undefined };
  const res: any = {
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(body: unknown) {
      captured.body = body;
      return res;
    },
  };
  return { res, captured };
}

function makeReq(query: Record<string, unknown> = {}, slug = "engineer") {
  return { params: { slug }, query } as any;
}

const ROW = {
  id: "t1",
  title: "A thread",
  last_message_at: "2026-07-18T10:00:00.000Z",
  created_at: "2026-07-18T09:00:00.000Z",
  last_message: "latest snippet",
  run_status: "parse_failed",
  pending: false,
  run_outcome: { deliverable: "here is the answer" },
  reply_count: 3,
  first_user_message: "can you look at the build",
};

beforeEach(() => {
  rpc.mockReset();
  loadAgentDefinition.mockClear();
});

describe("agentListThreadsFeed", () => {
  it("calls list_agent_threads_feed with slug, limit and before", async () => {
    rpc.mockResolvedValue({ data: [ROW], error: null });
    const { res, captured } = makeRes();
    await agentListThreadsFeed(
      makeReq({ limit: "25", before: "2026-07-18T12:00:00.000Z" }),
      res,
    );

    expect(rpc).toHaveBeenCalledWith("list_agent_threads_feed", {
      p_agent_slug: "engineer",
      p_limit: 25,
      p_before: "2026-07-18T12:00:00.000Z",
    });
    expect(captured.status).toBe(200);
  });

  it("never calls the switcher RPC (which would prune history)", async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    const { res } = makeRes();
    await agentListThreadsFeed(makeReq(), res);
    expect(rpc).not.toHaveBeenCalledWith(
      "list_agent_threads",
      expect.anything(),
    );
  });

  it("derives presentation_status and drops run_outcome", async () => {
    rpc.mockResolvedValue({ data: [ROW], error: null });
    const { res, captured } = makeRes();
    await agentListThreadsFeed(makeReq(), res);

    const t = (captured.body as any).threads[0];
    expect(t.presentation_status).toBe("answered");
    expect(t).not.toHaveProperty("run_outcome");
  });

  it("passes reply_count through verbatim (no second subtraction)", async () => {
    rpc.mockResolvedValue({ data: [ROW], error: null });
    const { res, captured } = makeRes();
    await agentListThreadsFeed(makeReq(), res);
    expect((captured.body as any).threads[0].reply_count).toBe(3);
  });

  it("coerces a null reply_count to 0", async () => {
    rpc.mockResolvedValue({
      data: [{ ...ROW, reply_count: null }],
      error: null,
    });
    const { res, captured } = makeRes();
    await agentListThreadsFeed(makeReq(), res);
    expect((captured.body as any).threads[0].reply_count).toBe(0);
  });

  it("emits presentation_status null when the thread has no linked run", async () => {
    rpc.mockResolvedValue({
      data: [{ ...ROW, run_status: null, run_outcome: null }],
      error: null,
    });
    const { res, captured } = makeRes();
    await agentListThreadsFeed(makeReq(), res);
    expect((captured.body as any).threads[0].presentation_status).toBeNull();
  });

  it("defaults before to null when absent", async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    const { res } = makeRes();
    await agentListThreadsFeed(makeReq(), res);
    expect(rpc.mock.calls[0][1].p_before).toBeNull();
  });

  it("400s a malformed before cursor instead of silently restarting page 1", async () => {
    const { res, captured } = makeRes();
    await agentListThreadsFeed(makeReq({ before: "not-a-date" }), res);
    expect(captured.status).toBe(400);
    expect((captured.body as any).error.code).toBe("bad_cursor");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("returns next_before on a full page and null on a short one", async () => {
    rpc.mockResolvedValue({ data: [ROW, { ...ROW, id: "t2" }], error: null });
    const full = makeRes();
    await agentListThreadsFeed(makeReq({ limit: "2" }), full.res);
    expect((full.captured.body as any).next_before).toBe(ROW.last_message_at);

    rpc.mockResolvedValue({ data: [ROW], error: null });
    const short = makeRes();
    await agentListThreadsFeed(makeReq({ limit: "50" }), short.res);
    expect((short.captured.body as any).next_before).toBeNull();
  });

  it("404s an unknown agent rather than answering an empty feed", async () => {
    const { res, captured } = makeRes();
    await agentListThreadsFeed(makeReq({}, "nope"), res);
    expect(captured.status).toBe(404);
    expect((captured.body as any).error.code).toBe("unknown_agent");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("500s on an RPC error", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    const { res, captured } = makeRes();
    await agentListThreadsFeed(makeReq(), res);
    expect(captured.status).toBe(500);
    expect((captured.body as any).error.code).toBe("rpc_failed");
  });
});
