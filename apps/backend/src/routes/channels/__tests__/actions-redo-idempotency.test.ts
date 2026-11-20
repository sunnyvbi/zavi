import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TENANT_A = "73db45ff-457e-4541-bc8f-bdb625390204";
const TENANT_B = "e0fe9ea8-1111-4222-8333-444455556666";
const ID = "0f4d7c1a-2b3c-4d5e-8f90-123456789abc";

const h = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const idem: Row[] = [];
  const claims: Row[] = [];
  const agentRuns: Row[] = [];
  const events: Row[] = [];
  const card = { status: "pending" };
  let runs = 0;
  const enqueueAgentRun = vi.fn(async () => ({ run_id: `run-${++runs}` }));
  const resetRuns = () => {
    runs = 0;
  };
  const action = {
    id: "0f4d7c1a-2b3c-4d5e-8f90-123456789abc",
    channel_slug: "seo",
    run_id: "run-0",
    position: 1,
    run_of: 3,
    title: "Tighten the title tags",
    title_key: "tighten-the-title-tags",
    status: "pending",
    exec_status: null,
    exec_class: null,
  };

  function chain(rowsFor: () => Row[], tenant: string, onDone: (hits: Row[]) => unknown) {
    const filters: Array<[string, unknown]> = [];
    const hits = () =>
      rowsFor().filter(
        (r) =>
          (r.tenant_id === undefined || r.tenant_id === tenant) &&
          filters.every(([c, v]) =>
            v && typeof v === "object" && "oneOf" in v ? (v as { oneOf: unknown[] }).oneOf.includes(r[c]) : r[c] === v,
          ),
      );
    const b: Record<string, unknown> = {
      eq(c: string, v: unknown) {
        filters.push([c, v]);
        return b;
      },
      in(c: string, vals: unknown[]) {
        filters.push([c, { oneOf: vals }]);
        return b;
      },
      order() {
        return b;
      },
      limit() {
        return b;
      },
      maybeSingle: async () => ({ data: hits()[0] ? { ...hits()[0] } : null, error: null }),
      single: async () => ({ data: hits()[0] ? { ...hits()[0] } : null, error: null }),
      then(res: (v: unknown) => void) {
        res(onDone(hits()));
      },
    };
    return b;
  }

  function rpc(tenant: string, name: string, args: Row) {
    if (name === "claim_channel_run") {
      const prior = claims.find(
        (c) => c.tenant_id === tenant && c.channel_slug === args.p_channel_slug && c.request_id === args.p_request_id,
      );
      if (prior) return { data: { ok: true, duplicate: true, claim_id: prior.id, run_id: prior.run_id ?? null }, error: null };
      const id = `claim-${claims.length + 1}`;
      claims.push({
        id,
        tenant_id: tenant,
        channel_slug: args.p_channel_slug,
        request_id: args.p_request_id,
        run_id: null,
        claimed_at: new Date().toISOString(),
      });
      return { data: { ok: true, duplicate: false, claim_id: id }, error: null };
    }
    if (name === "settle_channel_run_claim") {
      const c = claims.find((x) => x.id === args.p_claim_id);
      if (c) c.run_id = args.p_run_id;
      return { data: { ok: true }, error: null };
    }
    if (name === "release_channel_run_claim") {
      const i = claims.findIndex((c) => c.id === args.p_claim_id && c.tenant_id === tenant && c.run_id === null);
      if (i >= 0) claims.splice(i, 1);
      return { data: i >= 0, error: null };
    }
    if (name === "set_channel_action" && args.p_status === "redo_requested") {
      if (card.status !== "pending" && card.status !== "snoozed") {
        return { data: { ok: false, code: "illegal_transition" }, error: null };
      }
      events.push({ tenant_id: tenant, event_key: args.p_event_key, note: args.p_note, actor: args.p_actor_user_id });
      return { data: { ok: true, status: "pending" }, error: null };
    }
    return { data: { ok: true }, error: null };
  }

  function table(name: string, tenant: string) {
    if (name === "agent_runs") {
      return { select: () => chain(() => agentRuns, tenant, (rows) => ({ data: rows, error: null })) };
    }
    if (name === "channel_run_claims") {
      return { select: () => chain(() => claims, tenant, (rows) => ({ data: rows, error: null })) };
    }
    if (name === "request_idempotency") {
      return {
        insert: async (row: Row) => {
          const r: Row = { ...row, tenant_id: tenant };
          if (idem.some((x) => x.tenant_id === tenant && x.route === r.route && x.idem_key === r.idem_key)) {
            return { error: { code: "23505", message: "duplicate key" } };
          }
          idem.push(r);
          return { error: null };
        },
        select: () => chain(() => idem, tenant, (rows) => ({ data: rows, error: null })),
        update: (values: Row) =>
          chain(() => idem, tenant, (rows) => {
            for (const r of rows) Object.assign(r, values);
            return { error: null };
          }),
        delete: () =>
          chain(() => idem, tenant, (rows) => {
            for (const r of rows) idem.splice(idem.indexOf(r), 1);
            return { error: null };
          }),
      };
    }
    return { select: () => chain(() => [{ ...action }], tenant, (rows) => ({ data: rows, error: null })) };
  }
  class OutOfCredits extends Error {}
  return { idem, claims, agentRuns, events, card, table, rpc, enqueueAgentRun, resetRuns, OutOfCredits };
});

vi.mock("@/services/agents/deepagent/engine", () => ({}));
vi.mock("@/services/growth/preview-plan", async (orig) =>
  (await import("@/__tests__/helpers/tenant-plan")).previewPlanOn(orig),
);
vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async (req: express.Request, res: express.Response) => {
    const t = req.headers["x-test-tenant"];
    if (typeof t !== "string") {
      res.status(401).json({ error: { code: "unauthenticated" } });
      return null;
    }
    req.auth = { tenant_id: t, user_id: "u-1", access_token: "tok" } as never;
    return req.auth;
  }),
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: vi.fn(async (t: string, name: string, args: Record<string, unknown>) => h.rpc(t, name, args)),
  globalClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
  }),
  tenantClient: (tid: string) => ({ from: (t: string) => h.table(t, tid) }),
}));
vi.mock("@/services/agents/runner", () => ({ enqueueAgentRun: h.enqueueAgentRun, InsufficientCreditsError: h.OutOfCredits }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));
vi.mock("@/../workers/client", () => ({ inngest: { send: vi.fn(async () => undefined) } }));

import { channelActionRedo } from "../actions";
import { mountIdempotency } from "@/services/http/idempotency";

let server: Server;
let base = "";

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  mountIdempotency(app);
  app.post("/api/channel-actions/:id/redo", channelActionRedo);
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
});

beforeEach(() => {
  h.idem.length = 0;
  h.claims.length = 0;
  h.agentRuns.length = 0;
  h.events.length = 0;
  h.card.status = "pending";
  h.enqueueAgentRun.mockClear();
  h.resetRuns();
});

async function redo(opts: { key?: string; tenant: string; body?: Record<string, unknown> }) {
  const headers: Record<string, string> = { "Content-Type": "application/json", "x-test-tenant": opts.tenant };
  if (opts.key) headers["Idempotency-Key"] = opts.key;
  const res = await fetch(`${base}/api/channel-actions/${ID}/redo`, {
    method: "POST",
    headers,
    body: JSON.stringify(opts.body ?? { note: "too vague" }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown>, replayed: res.headers.get("idempotent-replayed") };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

describe("POST /api/channel-actions/:id/redo kind", () => {
  const redoPayload = () =>
    (h.enqueueAgentRun.mock.calls[0] as unknown as [{ payload: { redo: Record<string, unknown> } }])[0].payload.redo;

  it("an answer reaches the run as redo.kind 'answer'", async () => {
    const a = await redo({ tenant: TENANT_A, body: { note: "@examplebrand_fan, @healthwithkim", kind: "answer" } });
    expect(a.status).toBe(202);
    expect(redoPayload()).toMatchObject({ note: "@examplebrand_fan, @healthwithkim", kind: "answer" });
  });

  it("a plain redo carries no kind", async () => {
    await redo({ tenant: TENANT_A });
    expect("kind" in redoPayload()).toBe(false);
  });

  it("an unknown kind is refused before anything runs", async () => {
    const a = await redo({ tenant: TENANT_A, body: { note: "too vague", kind: "rewrite" } });
    expect(a.status).toBe(400);
    expect(h.enqueueAgentRun).not.toHaveBeenCalled();
  });
});

describe("POST /api/channel-actions/:id/redo with Idempotency-Key (real handler)", () => {
  it("same key twice: ONE run is enqueued and the replay gets the first answer", async () => {
    const a = await redo({ key: "redo-key-0001", tenant: TENANT_A });
    await tick();
    const b = await redo({ key: "redo-key-0001", tenant: TENANT_A });
    expect(a.status).toBeLessThan(300);
    expect(h.enqueueAgentRun).toHaveBeenCalledTimes(1);
    expect(b.status).toBe(a.status);
    expect(b.json).toEqual(a.json);
    expect(b.replayed).toBe("true");
  });

  it("two presses at once with no key: ONE run, the second gets the same run", async () => {
    const [a, b] = await Promise.all([redo({ tenant: TENANT_A }), redo({ tenant: TENANT_A })]);
    expect(h.enqueueAgentRun).toHaveBeenCalledTimes(1);
    expect([a.status, b.status]).toEqual([202, 202]);
    expect(h.events).toHaveLength(2);
    const dup = [a, b].find((r) => r.json.duplicate === true);
    expect(dup).toBeDefined();
  });

  it("different keys while the first redo is still running: ONE run", async () => {
    const a = await redo({ key: "redo-key-0001", tenant: TENANT_A });
    const b = await redo({ key: "redo-key-0002", tenant: TENANT_A });
    expect(h.enqueueAgentRun).toHaveBeenCalledTimes(1);
    expect(b.json).toMatchObject({ ok: true, run_id: a.json.run_id, duplicate: true });
    expect(h.events).toHaveLength(2);
  });

  it("after the first redo finished without replacing the card, a new press runs again", async () => {
    const a = await redo({ tenant: TENANT_A });
    h.agentRuns.push({ tenant_id: TENANT_A, id: a.json.run_id, "payload->>redo_of_action_id": ID, status: "failed" });
    const b = await redo({ tenant: TENANT_A });
    const c = await redo({ tenant: TENANT_A });
    expect(h.enqueueAgentRun).toHaveBeenCalledTimes(2);
    expect(b.json.duplicate).toBeUndefined();
    expect(c.json).toMatchObject({ run_id: b.json.run_id, duplicate: true });
  });

  it("a redo pressed while the card's redo is still running is refused before anything is recorded", async () => {
    const a = await redo({ tenant: TENANT_A });
    h.agentRuns.push({ tenant_id: TENANT_A, id: a.json.run_id, "payload->>redo_of_action_id": ID, status: "running" });
    const b = await redo({ tenant: TENANT_A });
    expect(b.status).toBe(409);
    expect(b.json.error).toMatchObject({ code: "redo_in_flight" });
    expect(h.enqueueAgentRun).toHaveBeenCalledTimes(1);
    expect(h.events).toHaveLength(1);
  });

  it.each(["blocked", "done", "paused_awaiting_approval"])("a redo run left in %s does not lock the card for good", async (status) => {
    const a = await redo({ tenant: TENANT_A });
    h.agentRuns.push({ tenant_id: TENANT_A, id: a.json.run_id, "payload->>redo_of_action_id": ID, status });
    const b = await redo({ tenant: TENANT_A });
    expect(b.status).toBe(202);
    expect(b.json.duplicate).toBeUndefined();
    expect(h.enqueueAgentRun).toHaveBeenCalledTimes(2);
  });

  it("a finished redo run with no channel stamp still reopens the card", async () => {
    const a = await redo({ tenant: TENANT_A });
    h.agentRuns.push({
      tenant_id: TENANT_A,
      id: a.json.run_id,
      channel_slug: null,
      "payload->>redo_of_action_id": ID,
      status: "success",
    });
    const b = await redo({ tenant: TENANT_A });
    expect(h.enqueueAgentRun).toHaveBeenCalledTimes(2);
    expect(b.json.duplicate).toBeUndefined();
  });

  it("a claim abandoned before its run was enqueued is released after thirty minutes", async () => {
    h.claims.push({
      id: "claim-dead",
      tenant_id: TENANT_A,
      channel_slug: "seo",
      request_id: `redo:${ID}:0`,
      run_id: null,
      claimed_at: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
    });
    const a = await redo({ tenant: TENANT_A });
    expect(h.enqueueAgentRun).toHaveBeenCalledTimes(1);
    expect(a.json.duplicate).toBeUndefined();
  });

  it("an old claim whose run was enqueued but never recorded on it is not released", async () => {
    h.claims.push({
      id: "claim-orphan",
      tenant_id: TENANT_A,
      channel_slug: "seo",
      request_id: `redo:${ID}:0`,
      run_id: null,
      claimed_at: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
    });
    h.agentRuns.push({ tenant_id: TENANT_A, id: "run-live", "payload->>redo_of_action_id": ID, status: "running" });
    const a = await redo({ tenant: TENANT_A });
    expect(h.enqueueAgentRun).not.toHaveBeenCalled();
    expect(a.status).toBe(409);
    expect(h.claims.some((c) => c.id === "claim-orphan")).toBe(true);
  });

  it("a claim still being enqueued is not released", async () => {
    h.claims.push({
      id: "claim-live",
      tenant_id: TENANT_A,
      channel_slug: "seo",
      request_id: `redo:${ID}:0`,
      run_id: null,
      claimed_at: new Date(Date.now() - 10 * 1000).toISOString(),
    });
    const a = await redo({ tenant: TENANT_A });
    expect(h.enqueueAgentRun).not.toHaveBeenCalled();
    expect(a.json).toMatchObject({ duplicate: true, run_id: null });
  });

  it("a press on a card the founder has since closed starts no run", async () => {
    await redo({ tenant: TENANT_A });
    h.card.status = "acted";
    const b = await redo({ key: "redo-key-0009", tenant: TENANT_A });
    expect(b.status).toBe(409);
    expect(h.enqueueAgentRun).toHaveBeenCalledTimes(1);
  });

  it("a retry after a press that started no run records its own note", async () => {
    h.claims.push({ id: "c-gone", tenant_id: TENANT_A, channel_slug: "seo", request_id: "unrelated", run_id: null, claimed_at: new Date().toISOString() });
    const first = await fetch(`${base}/api/channel-actions/${ID}/redo`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-tenant": TENANT_A },
      body: JSON.stringify({ note: "first note" }),
    });
    expect(first.status).toBe(202);
    h.claims.length = 0;
    h.enqueueAgentRun.mockClear();
    const second = await fetch(`${base}/api/channel-actions/${ID}/redo`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-tenant": TENANT_A },
      body: JSON.stringify({ note: "second note" }),
    });
    expect(second.status).toBe(202);
    expect(h.events.map((e) => e.note)).toEqual(["first note", "second note"]);
    expect(new Set(h.events.map((e) => e.event_key)).size).toBe(2);
  });

  it("a redo with no credits left answers 402 with the founder's top-up sentence, not a 500 with developer text", async () => {
    h.enqueueAgentRun.mockRejectedValueOnce(new h.OutOfCredits('Agent "seo" rejected: out of credits'));
    const r = await redo({ tenant: TENANT_A });
    expect(r.status).toBe(402);
    expect(r.json.error).toMatchObject({ code: "insufficient_credits" });
    expect(JSON.stringify(r.json)).not.toContain("rejected");
  });

  it("an unexpected enqueue failure gives a plain sentence, never the raw exception text", async () => {
    h.enqueueAgentRun.mockRejectedValueOnce(new Error("relation agent_runs does not exist"));
    const r = await redo({ tenant: TENANT_A });
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.json)).not.toContain("relation");
  });

  it("a note that is too short is refused in plain words", async () => {
    const res = await fetch(`${base}/api/channel-actions/${ID}/redo`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-tenant": TENANT_A },
      body: JSON.stringify({ note: "x" }),
    });
    const json = (await res.json()) as { error: { message: string } };
    expect(res.status).toBe(400);
    expect(json.error.message).toBe("The note is too short. Use at least 3 characters.");
    expect(json.error.message).not.toMatch(/✖|→/);
  });

  it("an answer may be one character (\"2\", \"B\"); a plain redo still needs 3", async () => {
    const ok = await redo({ tenant: TENANT_A, body: { note: "2", kind: "answer" } });
    expect(ok.status).toBe(202);
    const res = await fetch(`${base}/api/channel-actions/${ID}/redo`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-tenant": TENANT_A },
      body: JSON.stringify({ note: "ab" }),
    });
    expect(res.status).toBe(400);
  });

  it("a finished redo of ANOTHER card does not reopen this one", async () => {
    await redo({ tenant: TENANT_A });
    h.agentRuns.push({
      tenant_id: TENANT_A,
      id: "run-other",
      "payload->>redo_of_action_id": "11111111-2222-4333-8444-555566667777",
      status: "failed",
    });
    await redo({ tenant: TENANT_A });
    expect(h.enqueueAgentRun).toHaveBeenCalledTimes(1);
  });

  it("cross-tenant: the same key from another tenant never returns this tenant's result", async () => {
    await redo({ key: "redo-key-0001", tenant: TENANT_A });
    await tick();
    const b = await redo({ key: "redo-key-0001", tenant: TENANT_B });
    expect(b.json.duplicate).toBeUndefined();
    expect(b.replayed).toBeNull();
    expect(h.enqueueAgentRun).toHaveBeenCalledTimes(2);
    const tenants = (h.enqueueAgentRun.mock.calls as unknown as Array<[{ tenant_id: string }]>).map((c) => c[0].tenant_id);
    expect(tenants).toEqual([TENANT_A, TENANT_B]);
  });
});
