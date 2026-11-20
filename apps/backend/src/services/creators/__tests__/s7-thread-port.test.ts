
import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/creators/thread", () => ({
  authorizeCreatorThreadAccess: vi.fn(),
  ensureCreatorThread: vi.fn(),
  listCreatorThreadMessages: vi.fn(),
  postCreatorThreadMessage: vi.fn(),
}));
vi.mock("@/services/creators/library", () => ({ createLibraryAssetOnApproval: vi.fn() }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: vi.fn(),
}));

import { makeCreatorThreadPort, orderThreadId, type ThreadPortDeps } from "../s7-ports";
import { tenantClient } from "@/services/tenant-client";
import type { CreatorThreadAccessResult } from "../thread";

const TENANT = "22222222-0000-4000-8000-000000000002";
const OTHER_TENANT = "99999999-0000-4000-8000-000000000009";
const ORDER = "33333333-0000-4000-8000-000000000003";
const THREAD = "44444444-0000-4000-8000-000000000004";
const OWNER = "owner-user";
const STRANGER = "stranger-user";

function harness(result: CreatorThreadAccessResult, orderThread: string | null = THREAD) {
  const posted: unknown[] = [];
  const authorize = vi.fn(async () => result);
  const list = vi.fn(async () => [
    { id: "m1", sender_kind: "creator", body: "Draft is up", created_at: "2026-09-20T10:00:00Z" },
  ]);
  const deps: ThreadPortDeps = {
    authorize: authorize as never,
    list: list as never,
    post: (async (a: unknown) => {
      posted.push(a);
      return { id: "m2", sender_kind: "tenant", body: "ok", created_at: "x" };
    }) as never,
    orderThreadId: vi.fn(async () => orderThread),
  };
  return { port: makeCreatorThreadPort(deps), authorize, list, posted, deps };
}

const tenantAccess = (tenant_id = TENANT): CreatorThreadAccessResult => ({
  ok: true,
  access: { tenant_id, thread_id: THREAD, human_member_id: "m", sender_kind: "tenant" },
});

describe("reading the thread onto the business job screen", () => {
  it("shows the messages to a member of the owning tenant", async () => {
    const h = harness(tenantAccess());
    const v = await h.port.readThread({ auth_user_id: OWNER, tenant_id: TENANT, order_id: ORDER, thread_id: THREAD });
    expect(h.authorize).toHaveBeenCalledWith({ auth_user_id: OWNER, thread_id: THREAD });
    expect(v.available).toBe(true);
    expect(v.messages.map((m) => m.body)).toEqual(["Draft is up"]);
  });

  it("a foreign user reads nothing and learns nothing", async () => {
    const h = harness({ ok: false, code: "not_authorized" });
    const v = await h.port.readThread({ auth_user_id: STRANGER, tenant_id: TENANT, order_id: ORDER, thread_id: THREAD });
    expect(v).toEqual({ available: false, thread_id: null, messages: [] });
    expect(h.list).not.toHaveBeenCalled();
  });

  it("refuses a thread that resolves to a different tenant than requireAuth validated", async () => {
    const h = harness(tenantAccess(OTHER_TENANT));
    const v = await h.port.readThread({ auth_user_id: OWNER, tenant_id: TENANT, order_id: ORDER, thread_id: THREAD });
    expect(v.available).toBe(false);
    expect(h.list).not.toHaveBeenCalled();
  });

  it("refuses a caller who resolves as the creator side", async () => {
    const h = harness({
      ok: true,
      access: { tenant_id: TENANT, thread_id: THREAD, human_member_id: "m", sender_kind: "creator" },
    });
    const v = await h.port.readThread({ auth_user_id: OWNER, tenant_id: TENANT, order_id: ORDER, thread_id: THREAD });
    expect(v.available).toBe(false);
  });

  it("an order with no thread yet is an honest empty conversation", async () => {
    const h = harness(tenantAccess(), null);
    const v = await h.port.readThread({ auth_user_id: OWNER, tenant_id: TENANT, order_id: ORDER, thread_id: null });
    expect(v).toEqual({ available: true, thread_id: null, messages: [] });
    expect(h.authorize).not.toHaveBeenCalled();
  });
});

describe("mirroring a business note into the thread", () => {
  it("posts as the verified user, with the side taken from the access check", async () => {
    const h = harness(tenantAccess());
    const r = await h.port.postMessage({ auth_user_id: OWNER, tenant_id: TENANT, order_id: ORDER, thread_id: null, body: "Re-shoot the hook" });
    expect(r.posted).toBe(true);
    expect(h.deps.orderThreadId).toHaveBeenCalledWith(TENANT, ORDER);
    expect(h.posted).toEqual([
      {
        access: { tenant_id: TENANT, thread_id: THREAD, human_member_id: "m", sender_kind: "tenant" },
        sender_user_id: OWNER,
        body: "Re-shoot the hook",
      },
    ]);
  });

  it("a foreign user posts nothing", async () => {
    const h = harness({ ok: false, code: "thread_not_found" });
    const r = await h.port.postMessage({ auth_user_id: STRANGER, tenant_id: TENANT, order_id: ORDER, thread_id: THREAD, body: "hi" });
    expect(r.posted).toBe(false);
    expect(h.posted).toEqual([]);
  });

  it("a thread in another tenant posts nothing", async () => {
    const h = harness(tenantAccess(OTHER_TENANT));
    const r = await h.port.postMessage({ auth_user_id: OWNER, tenant_id: TENANT, order_id: ORDER, thread_id: THREAD, body: "hi" });
    expect(r.posted).toBe(false);
    expect(h.posted).toEqual([]);
  });
});

describe("a package booking with no thread_id reads the workspace-and-creator thread", () => {
  function fakeClient(rows: Record<string, unknown>) {
    const calls: Array<{ table: string; filters: Array<[string, unknown]> }> = [];
    const client = {
      from(table: string) {
        const call = { table, filters: [] as Array<[string, unknown]> };
        calls.push(call);
        const b: Record<string, unknown> = {};
        b.select = () => b;
        b.eq = (k: string, v: unknown) => (call.filters.push([k, v]), b);
        b.order = () => b;
        b.limit = () => b;
        b.maybeSingle = async () => ({ data: rows[table] ?? null, error: null });
        return b;
      },
    };
    vi.mocked(tenantClient).mockReturnValue(client as never);
    return calls;
  }

  it("uses the order's own thread when it has one", async () => {
    const calls = fakeClient({ creator_orders: { thread_id: THREAD, human_member_id: "m" } });
    expect(await orderThreadId(TENANT, ORDER)).toBe(THREAD);
    expect(calls.map((c) => c.table)).toEqual(["creator_orders"]);
  });

  it("falls back to the pair thread, keyed on the ORDER's creator inside the caller's tenant", async () => {
    const calls = fakeClient({ creator_orders: { thread_id: null, human_member_id: "m" }, creator_threads: { id: "pair-thread" } });
    expect(await orderThreadId(TENANT, ORDER)).toBe("pair-thread");
    expect(tenantClient).toHaveBeenCalledWith(TENANT);
    expect(calls[1]).toEqual({ table: "creator_threads", filters: [["human_member_id", "m"]] });
  });

  it("an order this tenant cannot see resolves to no thread at all", async () => {
    fakeClient({});
    expect(await orderThreadId(TENANT, ORDER)).toBeNull();
  });

  it("the fallback thread still goes through the business access check", async () => {
    const h = harness({ ok: false, code: "not_authorized" }, "pair-thread");
    const v = await h.port.readThread({ auth_user_id: STRANGER, tenant_id: TENANT, order_id: ORDER, thread_id: null });
    expect(h.authorize).toHaveBeenCalledWith({ auth_user_id: STRANGER, thread_id: "pair-thread" });
    expect(v.available).toBe(false);
  });
});

describe("a note posted on a job with no thread yet (a package booking)", () => {
  it("opens the pair thread, then posts after the same access check", async () => {
    const h = harness(tenantAccess(), null);
    const openThread = vi.fn(async () => THREAD);
    const port = makeCreatorThreadPort({ ...h.deps, openThread });
    const r = await port.postMessage({ auth_user_id: OWNER, tenant_id: TENANT, order_id: ORDER, thread_id: null, body: "Brighter light please" });
    expect(openThread).toHaveBeenCalledWith(TENANT, ORDER, OWNER);
    expect(h.authorize).toHaveBeenCalledWith({ auth_user_id: OWNER, thread_id: THREAD });
    expect(r.posted).toBe(true);
    expect(h.posted).toHaveLength(1);
  });

  it("still refuses a caller the opened thread does not belong to", async () => {
    const h = harness(tenantAccess(OTHER_TENANT), null);
    const port = makeCreatorThreadPort({ ...h.deps, openThread: vi.fn(async () => THREAD) });
    const r = await port.postMessage({ auth_user_id: STRANGER, tenant_id: TENANT, order_id: ORDER, thread_id: null, body: "x" });
    expect(r.posted).toBe(false);
    expect(h.posted).toHaveLength(0);
  });
});
