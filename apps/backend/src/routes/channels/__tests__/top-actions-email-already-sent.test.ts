import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const h = vi.hoisted(() => ({
  start: vi.fn(),
  runs: [] as Row[],
  cards: [] as Row[],
  fail: null as string | null,
  reads: [] as string[],
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: vi.fn(async () => ({ tenant_id: "73db45ff-457e-4541-bc8f-bdb625390204", user_id: "u1", access_token: "t" })) }));
vi.mock("@/services/auth/tenant-role", () => ({ requireTenantRole: vi.fn(async () => true) }));
vi.mock("../run", () => ({ startChannelRun: h.start }));
vi.mock("@/services/agents/runner", () => ({ canCurrentUserReadRun: async () => true }));
vi.mock("@/services/channels/channel-actions", () => ({ listActionViewsForRun: async () => [] }));
vi.mock("@/services/agents/entitlement", async (orig) => ({
  ...(await orig<typeof import("@/services/agents/entitlement")>()),
  checkAgentTier: async () => ({ enforced: true, tier: "pro", required_tier: "pro", allowed: true }),
}));
vi.mock("@/services/email-plan/preflight", () => ({ emailRunPreflight: async () => ({ verdict: "ok" }) }));
vi.mock("@/services/tenant-client", () => {
  const client = () => ({
    from: (table: string) => {
      h.reads.push(table);
      const filters: Array<(r: Row) => boolean> = [];
      const q: Record<string, unknown> = {};
      const pass = () => q;
      q.select = pass;
      q.order = pass;
      q.gte = pass;
      q.eq = (k: string, v: unknown) => {
        const path = k.split(/->>?/);
        filters.push((r) => path.reduce<unknown>((o, p) => (o as Row | undefined)?.[p], r) === v);
        return q;
      };
      q.in = (k: string, v: unknown[]) => {
        filters.push((r) => v.includes(r[k]));
        return q;
      };
      q.limit = async () => {
        if (h.fail === table) return { data: null, error: { message: "boom" } };
        return { data: (table === "agent_runs" ? h.runs : h.cards).filter((r) => filters.every((f) => f(r))), error: null };
      };
      return q;
    },
  });
  return { asTenantId: (s: string) => s, tenantClient: client, tenantRpc: async () => ({ data: null, error: null }), tenantStorage: () => ({ from: () => ({}) }), globalClient: client, applySecretListEditRpc: async () => ({ data: null, error: null }), StaleRevisionError: class extends Error {} };
});

import { startTopAction } from "../top-actions";
import { EMAIL_ALREADY_SENT } from "@/services/channels/top-actions";

const BRIEF = "Announce something new: Happy Diwali";
const inputs = { route: "mailchimp", list_id: "a1b2c3", brief: BRIEF };
const pastRun = (id: string, over: Row = {}) => ({ id, channel_slug: "email_marketing", payload: { top_action: { key: "new_email", inputs: { ...inputs, ...over } } } });
const card = (run_id: string, over: Row = {}) => ({ id: `c-${run_id}`, run_id, status: "acted", exec_status: "executed", ...over });

function res() {
  const r = { _status: 200, _body: undefined as unknown, status(n: number) { r._status = n; return r; }, json(b: unknown) { r._body = b; return r; } };
  return r;
}
async function press(over: Row = {}) {
  const r = res();
  await startTopAction({ params: { slug: "email_marketing", key: "new_email" }, body: { request_id: "request-0001", inputs: { ...inputs, ...over } } } as unknown as Request, r as unknown as Response);
  return r;
}

beforeEach(() => {
  h.start.mockReset().mockImplementation(async (r: Response) => { r.json({ ok: true }); });
  h.runs = [];
  h.cards = [];
  h.fail = null;
  h.reads = [];
});

describe("Write it for an email this list already got", () => {
  it("refuses with plain words and starts no paid run, whatever the spacing or case of the brief", async () => {
    h.runs = [pastRun("r1")];
    h.cards = [card("r1")];
    const r = await press({ brief: "  announce something NEW:   happy diwali " });
    expect(r._status).toBe(409);
    expect(r._body).toEqual({ error: { code: "top_action_unsupported", message: EMAIL_ALREADY_SENT } });
    expect(EMAIL_ALREADY_SENT).not.toMatch(/card|[0-9a-f]{8}/i);
    expect(h.start).not.toHaveBeenCalled();
  });

  it.each([
    ["another brief", [pastRun("r1", { brief: "Our spring sale" })], [card("r1")]],
    ["another list", [pastRun("r1", { list_id: "zzz" })], [card("r1")]],
    ["another tool", [pastRun("r1", { route: "klaviyo" })], [card("r1")]],
    ["another subject", [pastRun("r1", { subject: "Diwali wishes" })], [card("r1")]],
    ["a send that failed", [pastRun("r1")], [card("r1", { exec_status: "failed" })]],
    ["a card still waiting", [pastRun("r1")], [card("r1", { status: "pending", exec_status: null })]],
    ["a run that filed nothing", [pastRun("r1")], []],
  ])("still writes after %s", async (_name, runs, cards) => {
    h.runs = runs;
    h.cards = cards;
    await press();
    expect(h.start).toHaveBeenCalledTimes(1);
  });

  it.each(["agent_runs", "channel_actions"])("a failed read of %s does not block the run", async (table) => {
    h.runs = [pastRun("r1")];
    h.cards = [card("r1")];
    h.fail = table;
    await press();
    expect(h.start).toHaveBeenCalledTimes(1);
  });

  it("a Zavi list is not checked: only the tool rail refuses a repeat", async () => {
    h.runs = [pastRun("r1", { route: "zavi_list" })];
    h.cards = [card("r1")];
    await press({ route: "zavi_list", list_id: "8f0c3c1e-2b1a-4c55-9d1e-4b7f1b2a9c10" });
    expect(h.reads).not.toContain("channel_actions");
  });
});
