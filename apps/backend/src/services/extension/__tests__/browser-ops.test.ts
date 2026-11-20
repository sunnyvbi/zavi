
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/supabase", async () => {
  const f = await import("./fake-ext-ops-db");
  return { serviceClient: () => f.fakeServiceClient };
});

import * as f from "./fake-ext-ops-db";
import {
  awaitOpResult,
  claimNextOp,
  completeOp,
  createPanelSession,
  endPanelSession,
  enqueueOp,
  expireHeldOp,
  isSessionLive,
  readOpStatus,
  releaseHeldOp,
  stopUserBrowserControl,
  touchPanelSession,
} from "@/services/extension/browser-ops";

const T1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const T2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const UA = "11111111-1111-4111-8111-111111111111";
const UB = "22222222-2222-4222-8222-222222222222";
const RUN = "33333333-3333-4333-8333-333333333333";
const RUN2 = "44444444-4444-4444-8444-444444444444";

const clock = f.clock;

beforeEach(() => f.resetDb());

async function claim(tenant: string, user: string, session: string) {
  return claimNextOp(tenant, user, session, { waitMs: 0 }, clock);
}

describe("panel sessions", () => {
  it("createPanelSession stamps the caller's tenant + user", async () => {
    const id = await createPanelSession(T1, UA, 7);
    expect(f.db.tables.extension_panel_sessions[0]).toMatchObject({
      id,
      tenant_id: T1,
      user_id: UA,
      tab_id: 7,
    });
  });

  it("another user in the same tenant cannot heartbeat A's session", async () => {
    const s = f.seedSession({ tenant_id: T1, user_id: UA, tab_id: 1 });
    const before = s.last_seen_at;
    f.advance(5_000);
    expect(await touchPanelSession(s.id as string, T1, UB, clock)).toBe(false);
    expect(s.last_seen_at).toBe(before);
    expect(await touchPanelSession(s.id as string, T1, UA, clock)).toBe(true);
    expect(s.last_seen_at).not.toBe(before);
  });

  it("the same user id in ANOTHER tenant cannot heartbeat the session", async () => {
    const s = f.seedSession({ tenant_id: T1, user_id: UA, tab_id: 1 });
    expect(await touchPanelSession(s.id as string, T2, UA, clock)).toBe(false);
  });

  it("a dead session (not seen for 30s) is not resurrected by a heartbeat", async () => {
    const s = f.seedSession({ tenant_id: T1, user_id: UA, tab_id: 1 });
    f.advance(31_000);
    expect(await touchPanelSession(s.id as string, T1, UA, clock)).toBe(false);
    expect(await isSessionLive(s.id as string, T1, UA, clock)).toBe(false);
  });

  it("an ended session cannot be heartbeated", async () => {
    const s = f.seedSession({ tenant_id: T1, user_id: UA, tab_id: 1 });
    expect(await endPanelSession(s.id as string, T1, UA, clock)).toBe(true);
    expect(await touchPanelSession(s.id as string, T1, UA, clock)).toBe(false);
    expect(await endPanelSession(s.id as string, T1, UA, clock)).toBe(true);
  });

  it("user B cannot end user A's session, cross-tenant neither", async () => {
    const s = f.seedSession({ tenant_id: T1, user_id: UA, tab_id: 1 });
    expect(await endPanelSession(s.id as string, T1, UB, clock)).toBe(false);
    expect(await endPanelSession(s.id as string, T2, UA, clock)).toBe(false);
    expect(s.ended_at).toBeNull();
  });

  it("isSessionLive is false for another user's session", async () => {
    const s = f.seedSession({ tenant_id: T1, user_id: UA, tab_id: 1 });
    expect(await isSessionLive(s.id as string, T1, UA, clock)).toBe(true);
    expect(await isSessionLive(s.id as string, T1, UB, clock)).toBe(false);
    expect(await isSessionLive(s.id as string, T2, UA, clock)).toBe(false);
  });
});

describe("enqueueOp", () => {
  const base = { run_id: RUN, seq: 1, op: { kind: "click_ref", ref: 4 }, is_write: true };

  it("queues onto the caller's live session", async () => {
    const s = f.seedSession({ tenant_id: T1, user_id: UA, tab_id: 9 });
    const r = await enqueueOp(
      { ...base, tenant_id: T1, user_id: UA, session_id: s.id as string, tab_id: 9 },
      clock,
    );
    expect(r.ok).toBe(true);
    expect(f.db.tables.extension_browser_ops[0]).toMatchObject({
      tenant_id: T1,
      user_id: UA,
      panel_session_id: s.id,
      status: "queued",
      is_write: true,
    });
  });

  it("refuses another user's session (no_panel), and a dead one", async () => {
    const s = f.seedSession({ tenant_id: T1, user_id: UA, tab_id: 9 });
    const other = await enqueueOp(
      { ...base, tenant_id: T1, user_id: UB, session_id: s.id as string, tab_id: 9 },
      clock,
    );
    expect(other).toEqual({ ok: false, reason: "no_panel" });
    f.advance(31_000);
    const dead = await enqueueOp(
      { ...base, tenant_id: T1, user_id: UA, session_id: s.id as string, tab_id: 9 },
      clock,
    );
    expect(dead).toEqual({ ok: false, reason: "no_panel" });
    expect(f.db.tables.extension_browser_ops).toHaveLength(0);
  });

  it("refuses a tab the session does not own", async () => {
    const s = f.seedSession({ tenant_id: T1, user_id: UA, tab_id: 9 });
    const r = await enqueueOp(
      { ...base, tenant_id: T1, user_id: UA, session_id: s.id as string, tab_id: 10 },
      clock,
    );
    expect(r).toEqual({ ok: false, reason: "tab_mismatch" });
  });
});

describe("claim + complete ownership", () => {
  function setup() {
    const sA = f.seedSession({ tenant_id: T1, user_id: UA, tab_id: 1 });
    const op = f.seedOp({
      tenant_id: T1,
      user_id: UA,
      run_id: RUN,
      panel_session_id: sA.id,
      tab_id: 1,
      seq: 1,
      is_write: true,
    });
    return { sA, op };
  }

  it("the owner claims it with a fresh execution token and never sees tenant/user ids", async () => {
    const { sA, op } = setup();
    const got = await claim(T1, UA, sA.id as string);
    expect(got.kind).toBe("op");
    if (got.kind !== "op") return;
    expect(got.op.id).toBe(op.id);
    expect(got.op.execution_token).toMatch(/^[0-9a-f-]{36}$/);
    expect(got.op).not.toHaveProperty("tenant_id");
    expect(got.op).not.toHaveProperty("user_id");
    expect(f.db.rpcCalls.at(-1)).toEqual({
      name: "claim_extension_op",
      args: { p_user_id: UA, p_session_id: sA.id, p_tenant_id: T1 },
    });
  });

  it("user B cannot claim A's op through A's session id (dead) or through B's own session", async () => {
    const { sA, op } = setup();
    expect((await claim(T1, UB, sA.id as string)).kind).toBe("dead");
    const sB = f.seedSession({ tenant_id: T1, user_id: UB, tab_id: 1 });
    expect((await claim(T1, UB, sB.id as string)).kind).toBe("timeout");
    expect(op.status).toBe("queued");
  });

  it("the same user id in another tenant cannot claim", async () => {
    const { sA, op } = setup();
    expect((await claim(T2, UA, sA.id as string)).kind).toBe("dead");
    expect(op.status).toBe("queued");
  });

  it("completion needs every identity to match; any mismatch is false and changes nothing", async () => {
    const { sA, op } = setup();
    const got = await claim(T1, UA, sA.id as string);
    if (got.kind !== "op") throw new Error("expected op");
    const good = {
      tenant_id: T1,
      user_id: UA,
      op_id: op.id as string,
      session_id: sA.id as string,
      run_id: RUN,
      execution_token: got.op.execution_token,
      status: "done" as const,
      result: { ok: 1 },
    };
    const sB = f.seedSession({ tenant_id: T1, user_id: UB, tab_id: 1 });
    const bad = [
      { ...good, user_id: UB },
      { ...good, user_id: UB, session_id: sB.id as string },
      { ...good, tenant_id: T2 },
      { ...good, run_id: RUN2 },
      { ...good, execution_token: "99999999-9999-4999-8999-999999999999" },
      { ...good, op_id: "88888888-8888-4888-8888-888888888888" },
    ];
    for (const b of bad) expect(await completeOp(b)).toBe(false);
    expect(op.status).toBe("delivered");
    expect(await completeOp(good)).toBe(true);
    expect(op).toMatchObject({ status: "done", result: { ok: 1 } });
    expect(await completeOp({ ...good, status: "failed" })).toBe(false);
    expect(op.status).toBe("done");
  });

  it("a result after the lease lapsed is refused", async () => {
    const { sA, op } = setup();
    const got = await claim(T1, UA, sA.id as string);
    if (got.kind !== "op") throw new Error("expected op");
    f.advance(16_000);
    const ok = await completeOp({
      tenant_id: T1,
      user_id: UA,
      op_id: op.id as string,
      session_id: sA.id as string,
      run_id: RUN,
      execution_token: got.op.execution_token,
      status: "done",
      result: null,
    });
    expect(ok).toBe(false);
  });
});

describe("lease expiry", () => {
  it("a WRITE whose lease lapses becomes unknown and is never delivered again", async () => {
    const s = f.seedSession({ tenant_id: T1, user_id: UA, tab_id: 1 });
    const op = f.seedOp({
      tenant_id: T1,
      user_id: UA,
      run_id: RUN,
      panel_session_id: s.id,
      tab_id: 1,
      seq: 1,
      is_write: true,
      expires_at: new Date(f.now() + 120_000).toISOString(),
    });
    const first = await claim(T1, UA, s.id as string);
    expect(first.kind).toBe("op");
    f.advance(16_000);
    await touchPanelSession(s.id as string, T1, UA, clock);
    const second = await claim(T1, UA, s.id as string);
    expect(second.kind).toBe("timeout");
    expect(op.status).toBe("unknown");
    f.advance(1_000);
    expect((await claim(T1, UA, s.id as string)).kind).toBe("timeout");
  });

  it("a READ whose lease lapses is re-claimable with a NEW token; the old token is dead", async () => {
    const s = f.seedSession({ tenant_id: T1, user_id: UA, tab_id: 1 });
    const op = f.seedOp({
      tenant_id: T1,
      user_id: UA,
      run_id: RUN,
      panel_session_id: s.id,
      tab_id: 1,
      seq: 1,
      is_write: false,
      expires_at: new Date(f.now() + 120_000).toISOString(),
    });
    const first = await claim(T1, UA, s.id as string);
    if (first.kind !== "op") throw new Error("expected op");
    f.advance(16_000);
    await touchPanelSession(s.id as string, T1, UA, clock);
    const second = await claim(T1, UA, s.id as string);
    if (second.kind !== "op") throw new Error("expected re-delivery");
    expect(second.op.id).toBe(op.id);
    expect(second.op.execution_token).not.toBe(first.op.execution_token);
    const args = {
      tenant_id: T1,
      user_id: UA,
      op_id: op.id as string,
      session_id: s.id as string,
      run_id: RUN,
      status: "done" as const,
      result: null,
    };
    expect(await completeOp({ ...args, execution_token: first.op.execution_token })).toBe(false);
    expect(await completeOp({ ...args, execution_token: second.op.execution_token })).toBe(true);
  });

  it("claimNextOp returns aborted without claiming once the signal fires", async () => {
    const s = f.seedSession({ tenant_id: T1, user_id: UA, tab_id: 1 });
    const op = f.seedOp({ tenant_id: T1, user_id: UA, run_id: RUN, panel_session_id: s.id, tab_id: 1, seq: 1 });
    const ac = new AbortController();
    ac.abort();
    const got = await claimNextOp(T1, UA, s.id as string, { signal: ac.signal }, clock);
    expect(got.kind).toBe("aborted");
    expect(op.status).toBe("queued");
  });

  it("claimNextOp long-polls until an op appears, then returns it", async () => {
    const s = f.seedSession({ tenant_id: T1, user_id: UA, tab_id: 1 });
    let ticks = 0;
    const c = {
      now: f.now,
      sleep: async (ms: number) => {
        f.advance(ms);
        if (++ticks === 3) {
          f.seedOp({ tenant_id: T1, user_id: UA, run_id: RUN, panel_session_id: s.id, tab_id: 1, seq: 1 });
        }
      },
    };
    const got = await claimNextOp(T1, UA, s.id as string, { waitMs: 25_000 }, c);
    expect(got.kind).toBe("op");
  });

  it("claimNextOp times out after waitMs with nothing queued", async () => {
    const s = f.seedSession({ tenant_id: T1, user_id: UA, tab_id: 1 });
    const t0 = f.now();
    const got = await claimNextOp(T1, UA, s.id as string, { waitMs: 25_000 }, clock);
    expect(got.kind).toBe("timeout");
    expect(f.now() - t0).toBeGreaterThanOrEqual(25_000);
  });
});

describe("awaitOpResult", () => {
  function seed(is_write: boolean) {
    const s = f.seedSession({ tenant_id: T1, user_id: UA, tab_id: 1 });
    const op = f.seedOp({
      tenant_id: T1,
      user_id: UA,
      run_id: RUN,
      panel_session_id: s.id,
      tab_id: 1,
      seq: 1,
      is_write,
    });
    return { s, op };
  }

  it("returns done with the result once the panel completes", async () => {
    const { s, op } = seed(true);
    const got = await claim(T1, UA, s.id as string);
    if (got.kind !== "op") throw new Error("expected op");
    await completeOp({
      tenant_id: T1,
      user_id: UA,
      op_id: op.id as string,
      session_id: s.id as string,
      run_id: RUN,
      execution_token: got.op.execution_token,
      status: "done",
      result: { url: "https://x.test" },
    });
    expect(await awaitOpResult({ tenant_id: T1, op_id: op.id as string }, {}, clock)).toEqual({
      status: "done",
      result: { url: "https://x.test" },
    });
  });

  it("keeps only the page address + outcome code stored once the result is read (no screenshot, no element list)", async () => {
    const { s, op } = seed(false);
    const got = await claim(T1, UA, s.id as string);
    if (got.kind !== "op") throw new Error("expected op");
    const full = { top_url: "https://a.test/x", image_base64: "AAAA", nodes: [{ n: 1, name: "Save" }] };
    await completeOp({
      tenant_id: T1,
      user_id: UA,
      op_id: op.id as string,
      session_id: s.id as string,
      run_id: RUN,
      execution_token: got.op.execution_token,
      status: "done",
      result: full,
    });
    const out = await awaitOpResult({ tenant_id: T1, op_id: op.id as string }, {}, clock);
    expect(out).toEqual({ status: "done", result: full });
    expect(f.opById(op.id).result).toEqual({ top_url: "https://a.test/x" });
  });

  it("drops the typed text from a finished type_ref step", async () => {
    const s = f.seedSession({ tenant_id: T1, user_id: UA, tab_id: 1 });
    const op = f.seedOp({
      tenant_id: T1, user_id: UA, run_id: RUN, panel_session_id: s.id, tab_id: 1, seq: 1, is_write: true,
      op: { op: "type_ref", ref: { frame_session: null, backend_node_id: 3 }, text: "my secret note" },
    });
    const got = await claim(T1, UA, s.id as string);
    if (got.kind !== "op") throw new Error("expected op");
    expect((got.op as { op: { text?: string } }).op.text).toBe("my secret note");
    await completeOp({
      tenant_id: T1, user_id: UA, op_id: op.id as string, session_id: s.id as string, run_id: RUN,
      execution_token: got.op.execution_token, status: "done", result: { top_url: "https://a.test/" },
    });
    await awaitOpResult({ tenant_id: T1, op_id: op.id as string }, {}, clock);
    expect(JSON.stringify(f.opById(op.id).op)).not.toContain("my secret note");
  });

  it("drops the option label from a finished select_option step (it is typed into the dropdown)", async () => {
    const s = f.seedSession({ tenant_id: T1, user_id: UA, tab_id: 1 });
    const op = f.seedOp({
      tenant_id: T1, user_id: UA, run_id: RUN, panel_session_id: s.id, tab_id: 1, seq: 1, is_write: true,
      op: { op: "select_option", ref: { frame_session: null, backend_node_id: 3 }, label: "Acme private audience" },
    });
    const got = await claim(T1, UA, s.id as string);
    if (got.kind !== "op") throw new Error("expected op");
    await completeOp({
      tenant_id: T1, user_id: UA, op_id: op.id as string, session_id: s.id as string, run_id: RUN,
      execution_token: got.op.execution_token, status: "done", result: { top_url: "https://a.test/", value: "Acme private audience" },
    });
    await awaitOpResult({ tenant_id: T1, op_id: op.id as string }, {}, clock);
    expect(JSON.stringify(f.opById(op.id))).not.toContain("Acme private audience");
  });

  it("drops typed text from a delivered write whose outcome was lost (unknown)", async () => {
    const s = f.seedSession({ tenant_id: T1, user_id: UA, tab_id: 1 });
    const op = f.seedOp({
      tenant_id: T1, user_id: UA, run_id: RUN, panel_session_id: s.id, tab_id: 1, seq: 1, is_write: true,
      op: { op: "type_ref", ref: { frame_session: null, backend_node_id: 3 }, text: "lost secret" },
    });
    const got = await claim(T1, UA, s.id as string);
    if (got.kind !== "op") throw new Error("expected op");
    const out = await awaitOpResult({ tenant_id: T1, op_id: op.id as string }, {}, clock);
    expect(out.status).toBe("unknown");
    expect(JSON.stringify(f.opById(op.id).op)).not.toContain("lost secret");
  });

  it("a declined held money step (expireHeldOp) loses its typed text", async () => {
    const s = f.seedSession({ tenant_id: T1, user_id: UA, tab_id: 1 });
    const op = f.seedOp({
      tenant_id: T1, user_id: UA, run_id: RUN, panel_session_id: s.id, tab_id: 1, seq: 1, is_write: true,
      status: "awaiting_confirm",
      op: { op: "type_ref", ref: { frame_session: null, backend_node_id: 3 }, text: "$50" },
    });
    await expireHeldOp(T1, op.id as string);
    expect(f.opById(op.id).status).toBe("expired");
    expect(JSON.stringify(f.opById(op.id).op)).not.toContain("$50");
  });

  it("a finished click loses its prompt answer (dialog_text) but keeps the rest", async () => {
    const s = f.seedSession({ tenant_id: T1, user_id: UA, tab_id: 1 });
    const op = f.seedOp({
      tenant_id: T1, user_id: UA, run_id: RUN, panel_session_id: s.id, tab_id: 1, seq: 1, is_write: true,
      status: "awaiting_confirm",
      op: { op: "click_ref", ref: { frame_session: null, backend_node_id: 3 }, dialog_text: "pin-7731" },
    });
    await expireHeldOp(T1, op.id as string);
    expect(JSON.stringify(f.opById(op.id).op)).not.toContain("pin-7731");
    expect(f.opById(op.id).op).toEqual({ op: "click_ref", ref: { frame_session: null, backend_node_id: 3 }, dialog_text: "[redacted]" });
  });

  it("never-delivered op → expired on timeout", async () => {
    const { op } = seed(true);
    const out = await awaitOpResult({ tenant_id: T1, op_id: op.id as string }, {}, clock);
    expect(out).toEqual({ status: "expired" });
    expect(op.status).toBe("expired");
  });

  it("delivered WRITE with no result → unknown on timeout, and it is not re-queued", async () => {
    const { s, op } = seed(true);
    await claim(T1, UA, s.id as string);
    const out = await awaitOpResult({ tenant_id: T1, op_id: op.id as string }, {}, clock);
    expect(out).toEqual({ status: "unknown" });
    expect(op.status).toBe("unknown");
    expect(f.db.tables.extension_browser_ops).toHaveLength(1);
  });

  it("delivered READ with no result → expired on timeout", async () => {
    const { s, op } = seed(false);
    await claim(T1, UA, s.id as string);
    expect(await awaitOpResult({ tenant_id: T1, op_id: op.id as string }, {}, clock)).toEqual({
      status: "expired",
    });
  });

  it("an op of another tenant reads as not_found", async () => {
    const { op } = seed(true);
    expect(await awaitOpResult({ tenant_id: T2, op_id: op.id as string }, {}, clock)).toEqual({
      status: "not_found",
    });
    expect(op.status).toBe("queued");
  });

  it("polls, and returns a result that lands before the deadline", async () => {
    const { s, op } = seed(false);
    const got = await claim(T1, UA, s.id as string);
    if (got.kind !== "op") throw new Error("expected op");
    let n = 0;
    const c = {
      now: f.now,
      sleep: async (ms: number) => {
        f.advance(ms);
        if (++n === 4) {
          await completeOp({
            tenant_id: T1,
            user_id: UA,
            op_id: op.id as string,
            session_id: s.id as string,
            run_id: RUN,
            execution_token: got.op.execution_token,
            status: "failed",
            result: { error: "no such ref" },
          });
        }
      },
    };
    expect(await awaitOpResult({ tenant_id: T1, op_id: op.id as string }, {}, c)).toEqual({
      status: "failed",
      result: { error: "no such ref" },
    });
  });
});

describe("stopUserBrowserControl (consent revoke)", () => {
  function seedAll() {
    const mine = f.seedSession({ tenant_id: T1, user_id: UA, tab_id: 1 });
    const teammate = f.seedSession({ tenant_id: T1, user_id: UB, tab_id: 2 });
    const otherTenant = f.seedSession({ tenant_id: T2, user_id: UA, tab_id: 3 });
    const op = (s: Record<string, unknown>, status: string, is_write: boolean, seq: number) =>
      f.seedOp({
        tenant_id: s.tenant_id,
        user_id: s.user_id,
        panel_session_id: s.id,
        run_id: RUN,
        tab_id: s.tab_id,
        seq,
        status,
        is_write,
      });
    return {
      mine,
      teammate,
      otherTenant,
      queued: op(mine, "queued", true, 1),
      leaseExpired: op(mine, "lease_expired", false, 2),
      awaiting: op(mine, "awaiting_confirm", true, 3),
      deliveredRead: op(mine, "delivered", false, 4),
      deliveredWrite: op(mine, "delivered", true, 5),
      done: op(mine, "done", true, 6),
      teammateOp: op(teammate, "queued", true, 7),
      otherTenantOp: op(otherTenant, "queued", true, 8),
    };
  }

  it("still erases stored steps when ending the panel sessions fails, then reports the failure", async () => {
    const x = seedAll();
    f.opById(x.done.id).result = { image_base64: "AAAA" };
    f.db.failUpdateOn = "extension_panel_sessions";
    await expect(stopUserBrowserControl(T1, UA, clock)).rejects.toThrow("db down");
    f.db.failUpdateOn = null;
    expect(f.opById(x.done.id).result).toBeNull();
    expect(f.opById(x.done.id).op).toEqual({ op: "redacted" });
  });

  it("if marking in-flight writes unknown fails, a delivered write is NOT relabelled expired", async () => {
    const x = seedAll();
    f.db.failUpdateIf = (table, payload) => table === "extension_browser_ops" && payload.status === "unknown";
    await expect(stopUserBrowserControl(T1, UA, clock)).rejects.toThrow("db down");
    f.db.failUpdateIf = null;
    expect(f.opById(x.deliveredWrite.id).status).toBe("delivered");
    expect(f.opById(x.queued.id).status).toBe("expired");
  });

  it("erases every stored step result of this user in this tenant, and only theirs", async () => {
    const x = seedAll();
    for (const o of [x.done, x.teammateOp, x.otherTenantOp]) f.opById(o.id).result = { image_base64: "AAAA" };
    await stopUserBrowserControl(T1, UA, clock);
    expect(f.opById(x.done.id).result).toBeNull();
    expect(f.opById(x.done.id).op).toEqual({ op: "redacted" });
    expect(f.opById(x.teammateOp.id).op).not.toEqual({ op: "redacted" });
    expect(f.opById(x.teammateOp.id).result).toEqual({ image_base64: "AAAA" });
    expect(f.opById(x.otherTenantOp.id).result).toEqual({ image_base64: "AAAA" });
  });

  it("ends this user's live sessions and settles their pending ops, write-in-flight as unknown", async () => {
    const x = seedAll();
    await stopUserBrowserControl(T1, UA, clock);
    expect(x.mine.ended_at).not.toBeNull();
    expect(x.queued.status).toBe("expired");
    expect(x.leaseExpired.status).toBe("expired");
    expect(x.awaiting.status).toBe("expired");
    expect(x.deliveredRead.status).toBe("expired");
    expect(x.deliveredWrite.status).toBe("unknown");
    expect(x.done.status).toBe("done");
  });

  it("leaves a teammate's session and ops alone", async () => {
    const x = seedAll();
    await stopUserBrowserControl(T1, UA, clock);
    expect(x.teammate.ended_at).toBeNull();
    expect(x.teammateOp.status).toBe("queued");
  });

  it("leaves the same person's session in ANOTHER tenant alone", async () => {
    const x = seedAll();
    await stopUserBrowserControl(T1, UA, clock);
    expect(x.otherTenant.ended_at).toBeNull();
    expect(x.otherTenantOp.status).toBe("queued");
  });

  it("after the stop, nothing more can be claimed or queued for that session", async () => {
    const x = seedAll();
    await stopUserBrowserControl(T1, UA, clock);
    expect((await claim(T1, UA, x.mine.id as string)).kind).toBe("dead");
    const q = await enqueueOp(
      { tenant_id: T1, user_id: UA, run_id: RUN2, session_id: x.mine.id as string, tab_id: 1, seq: 1, op: { op: "ax_snapshot" }, is_write: false },
      clock,
    );
    expect(q).toEqual({ ok: false, reason: "no_panel" });
  });
});

describe("held money steps (S3)", () => {
  const base = { run_id: RUN, seq: 1, op: { op: "click_ref" }, is_write: true };

  it("a held op is parked in awaiting_confirm and the panel cannot claim it", async () => {
    const s = f.seedSession({ tenant_id: T1, user_id: UA, tab_id: 9 });
    const r = await enqueueOp({ ...base, tenant_id: T1, user_id: UA, session_id: s.id as string, tab_id: 9, status: "awaiting_confirm" }, clock);
    expect(r.ok).toBe(true);
    expect(await readOpStatus(T1, (r as { op_id: string }).op_id)).toBe("awaiting_confirm");
    expect((await claim(T1, UA, s.id as string)).kind).toBe("timeout");
  });

  it("release makes it claimable once, for its own user only", async () => {
    const s = f.seedSession({ tenant_id: T1, user_id: UA, tab_id: 9 });
    const r = (await enqueueOp({ ...base, tenant_id: T1, user_id: UA, session_id: s.id as string, tab_id: 9, status: "awaiting_confirm" }, clock)) as { op_id: string };
    expect(await releaseHeldOp({ tenant_id: T1, user_id: UB, op_id: r.op_id }, clock)).toBe(false);
    expect(await releaseHeldOp({ tenant_id: T2, user_id: UA, op_id: r.op_id }, clock)).toBe(false);
    expect(await releaseHeldOp({ tenant_id: T1, user_id: UA, op_id: r.op_id }, clock)).toBe(true);
    expect(await releaseHeldOp({ tenant_id: T1, user_id: UA, op_id: r.op_id }, clock)).toBe(false);
    const c = await claim(T1, UA, s.id as string);
    expect(c.kind).toBe("op");
  });

  it("an expired (revoked / declined) held op can never be released", async () => {
    const s = f.seedSession({ tenant_id: T1, user_id: UA, tab_id: 9 });
    const r = (await enqueueOp({ ...base, tenant_id: T1, user_id: UA, session_id: s.id as string, tab_id: 9, status: "awaiting_confirm" }, clock)) as { op_id: string };
    await expireHeldOp(T1, r.op_id);
    expect(await readOpStatus(T1, r.op_id)).toBe("expired");
    expect(await releaseHeldOp({ tenant_id: T1, user_id: UA, op_id: r.op_id }, clock)).toBe(false);
  });

  it("consent revoke expires a held op", async () => {
    const s = f.seedSession({ tenant_id: T1, user_id: UA, tab_id: 9 });
    const r = (await enqueueOp({ ...base, tenant_id: T1, user_id: UA, session_id: s.id as string, tab_id: 9, status: "awaiting_confirm" }, clock)) as { op_id: string };
    await stopUserBrowserControl(T1, UA, clock);
    expect(await readOpStatus(T1, r.op_id)).toBe("expired");
  });
});
