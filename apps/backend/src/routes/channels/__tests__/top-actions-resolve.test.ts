
import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const USER = "0335f3eb-8f08-4f72-91e1-6cd085503f13";
const CARD = "22222222-2222-4222-8222-222222222222";

type Call = { table: string; method: string; args: unknown[] };
const h = vi.hoisted(() => ({
  start: vi.fn(),
  rpc: vi.fn(),
  tenantFor: [] as string[],
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
  card: null as unknown,
  failedRuns: 0,
}));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async () => ({ tenant_id: TENANT, user_id: USER, access_token: "t" })),
}));
vi.mock("@/services/auth/tenant-role", () => ({ requireTenantRole: vi.fn(async () => true) }));
vi.mock("../run", () => ({ startChannelRun: h.start }));
vi.mock("@/services/agents/runner", () => ({ canCurrentUserReadRun: vi.fn() }));
vi.mock("@/services/channels/channel-actions", () => ({ listActionViewsForRun: vi.fn() }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantRpc: h.rpc,
  tenantClient: (t: string) => {
    h.tenantFor.push(t);
    return {
      from: (table: string) => {
        const q: Record<string, unknown> = {};
        for (const m of ["select", "eq", "in"]) {
          q[m] = (...args: unknown[]) => {
            h.calls.push({ table, method: m, args });
            return q;
          };
        }
        q.maybeSingle = async () => ({ data: h.card, error: null });
        q.then = (resolve: (v: unknown) => void) => resolve({ count: h.failedRuns, error: null });
        return q;
      },
    };
  },
}));

import { startTopAction } from "../top-actions";

const topic = (n: number) => ({
  title: `Topic ${n}`,
  why: "w",
  searches: ["s"],
  ranks: [{ site: "a.com", note: "n" }],
  your_site: "none",
  have: [{ text: "fact", src: "a.com" }],
  fill: ["blank"],
});
const pickCard = (over: Record<string, unknown> = {}) => ({
  id: CARD,
  status: "pending",
  snoozed_until: null,
  exec_status: null,
  title: "Pick your next page",
  run_id: "33333333-3333-4333-8333-333333333333",
  position: 2,
  run_of: 5,
  kind: "proof_topics",
  presentation: { type: "topic_pick", topics: [topic(0), topic(1), topic(2)] },
  ...over,
});
function res() {
  const r = { _status: 200, _body: undefined as unknown, status(n: number) { r._status = n; return r; }, json(b: unknown) { r._body = b; return r; } };
  return r;
}
const post = (inputs: unknown) =>
  ({ params: { slug: "seo", key: "write_proof_page" }, body: { request_id: "client-req-123", inputs } }) as unknown as Request;

beforeEach(() => {
  h.start.mockReset().mockImplementation(async (r: Response) => { r.json({ ok: true }); });
  h.rpc.mockReset().mockResolvedValue({ data: { ok: true }, error: null });
  h.tenantFor.length = 0;
  h.calls.length = 0;
  h.card = pickCard();
  h.failedRuns = 0;
});

describe("write_proof_page start", () => {
  it("runs a redo of the pick card with the stored research and a server request id", async () => {
    const r = res();
    await startTopAction(post({ card_id: CARD, topic: 1 }), r as never);
    expect(h.start).toHaveBeenCalledTimes(1);
    const opts = h.start.mock.calls[0][3];
    expect(opts.redo.redo_of_action_id).toBe(CARD);
    expect(opts.redo.origin_position).toBe(2);
    expect(opts.topAction.inputs.topic_research.title).toBe("Topic 1");
    expect(opts.topAction.instruction).toContain(JSON.stringify("Topic 1"));
    expect(opts.requestId).toBe(`proof-pick:${CARD}:0`);
    expect(h.rpc).toHaveBeenCalledTimes(1);
    expect(h.rpc.mock.calls[0][1]).toBe("set_channel_action");
    expect(h.rpc.mock.calls[0][2]).toMatchObject({ p_action_id: CARD, p_status: "redo_requested", p_actor_user_id: USER, p_event_key: `redo_requested:proof-pick:${CARD}:0` });
  });

  it.each([
    ["used", { status: "redone" }],
    ["snoozed into the future", { status: "snoozed", snoozed_until: new Date(Date.now() + 86_400_000).toISOString() }],
    ["executing", { exec_status: "queued" }],
    ["another kind", { kind: "proof_page" }],
  ])("refuses a card that is %s", async (_n, over) => {
    h.card = pickCard(over);
    const r = res();
    await startTopAction(post({ card_id: CARD, topic: 1 }), r as never);
    expect(r._status).toBe(409);
    expect(h.start).not.toHaveBeenCalled();
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("refuses a topic that is not on the card", async () => {
    const r = res();
    await startTopAction(post({ card_id: CARD, topic: 4 }), r as never);
    expect(r._status).toBe(409);
    expect(h.start).not.toHaveBeenCalled();
  });

  it("a retry after a finished write run gets a new request id (failed, or succeeded with no page); live runs do not count", async () => {
    h.failedRuns = 1;
    await startTopAction(post({ card_id: CARD, topic: 0 }), res() as never);
    expect(h.start.mock.calls[0][3].requestId).toBe(`proof-pick:${CARD}:1`);
    const statusFilter = h.calls.find((c) => c.table === "agent_runs" && c.method === "in");
    expect(statusFilter?.args[0]).toBe("status");
    expect(statusFilter?.args[1]).toEqual(expect.arrayContaining(["success", "failed", "cancelled", "parse_failed", "dispatch_error"]));
    expect(statusFilter?.args[1]).not.toContain("queued");
    expect(statusFilter?.args[1]).not.toContain("running");
    expect(h.calls).toContainEqual({ table: "agent_runs", method: "eq", args: ["payload->top_action->inputs->>card_id", CARD] });
  });

  it("rejects research sent by the client", async () => {
    const r = res();
    await startTopAction(post({ card_id: CARD, topic: 0, topic_research: topic(9) }), r as never);
    expect(r._status).toBe(400);
    expect(h.start).not.toHaveBeenCalled();
  });

  it("reads the card in the caller's tenant, on seo only", async () => {
    await startTopAction(post({ card_id: CARD, topic: 0 }), res() as never);
    expect(h.tenantFor.every((t) => t === TENANT)).toBe(true);
    expect(h.tenantFor.length).toBeGreaterThan(0);
    expect(h.calls).toContainEqual({ table: "channel_actions", method: "eq", args: ["channel_slug", "seo"] });
    expect(h.calls).toContainEqual({ table: "channel_actions", method: "eq", args: ["id", CARD] });
  });

  it("a refused redo record starts no run", async () => {
    h.rpc.mockResolvedValue({ data: { ok: false, code: "illegal_transition" }, error: null });
    const r = res();
    await startTopAction(post({ card_id: CARD, topic: 0 }), r as never);
    expect(r._status).toBe(409);
    expect(h.start).not.toHaveBeenCalled();
  });
});
