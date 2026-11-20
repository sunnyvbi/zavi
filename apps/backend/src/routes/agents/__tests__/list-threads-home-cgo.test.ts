import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/supabase", () => ({ serverClientFromBearer: vi.fn() }));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: vi.fn() }));
vi.mock("@/services/agents/registry", () => ({ loadAgentDefinition: vi.fn() }));
vi.mock("@/services/agents/run-display-state", () => ({ presentationStatus: vi.fn() }));
vi.mock("@/services/agents/thread-unread", () => ({ attachThreadUnread: vi.fn() }));

import { listHomeCgoThreads, mergeByActivity } from "../list-threads";

type Call = { table: string; ops: Array<[string, ...unknown[]]> };

function fakeClient(tables: Record<string, { data: unknown; error: unknown }>) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const call: Call = { table, ops: [] };
    calls.push(call);
    const result = tables[table] ?? { data: [], error: null };
    const b: Record<string, unknown> = {};
    for (const op of ["select", "eq", "is", "not", "order", "limit", "in"]) {
      b[op] = (...args: unknown[]) => {
        call.ops.push([op, ...args]);
        return b;
      };
    }
    b.maybeSingle = async () => result;
    b.then = (res: (v: unknown) => void) => res(result);
    b.update = () => {
      throw new Error("no writes");
    };
    return b;
  };
  return { client: { from, rpc: () => { throw new Error("no rpc"); } } as never, calls };
}

const TENANT = "t-1";
const USER = "u-1";

describe("listHomeCgoThreads", () => {
  it("returns this user's operator threads that have a cgo handoff child, tagged from_home", async () => {
    const { client, calls } = fakeClient({
      agent_threads: {
        data: [
          { id: "op-1", title: "Growth question", last_message_at: "2026-10-21T10:00:00Z", created_at: "2026-10-21T09:00:00Z" },
          { id: "op-2", title: "Unrelated", last_message_at: "2026-10-21T11:00:00Z", created_at: "2026-10-21T09:00:00Z" },
          { id: "op-3", title: null, last_message_at: "2026-10-20T11:00:00Z", created_at: "2026-10-20T09:00:00Z" },
        ],
        error: null,
      },
      agent_runs: { data: [{ operator_thread_id: "op-1" }, { operator_thread_id: "op-3" }], error: null },
      agent_thread_messages: { data: { body: "What's holding my growth back?" }, error: null },
    });
    const rows = await listHomeCgoThreads(client, TENANT, USER);
    expect(rows.map((r) => r.id)).toEqual(["op-1", "op-3"]);
    expect(rows.every((r) => r.from_home === true)).toBe(true);
    expect(rows[1]!.last_message).toBe("What's holding my growth back?");

    const threads = calls.find((c) => c.table === "agent_threads")!.ops;
    expect(threads).toContainEqual(["eq", "tenant_id", TENANT]);
    expect(threads).toContainEqual(["eq", "user_id", USER]);
    expect(threads).toContainEqual(["eq", "agent_slug", "operator"]);
    expect(threads).toContainEqual(["is", "deleted_at", null]);
    expect(threads).toContainEqual(["not", "synthetic", "is", true]);

    const runs = calls.find((c) => c.table === "agent_runs")!.ops;
    expect(runs).toContainEqual(["eq", "tenant_id", TENANT]);
    expect(runs).toContainEqual(["eq", "agent_slug", "cgo"]);
    expect(runs).toContainEqual(["eq", "trigger", "handoff"]);
    expect(runs).toContainEqual(["in", "payload->>operator_thread_id", ["op-1", "op-2", "op-3"]]);
  });

  it("a failed read returns nothing instead of failing the list", async () => {
    const { client } = fakeClient({
      agent_threads: { data: [{ id: "op-1", title: "x", last_message_at: null, created_at: null }], error: null },
      agent_runs: { data: null, error: { message: "denied" } },
    });
    expect(await listHomeCgoThreads(client, TENANT, USER)).toEqual([]);
  });

  it("skips the run read when the user has no operator threads", async () => {
    const { client, calls } = fakeClient({ agent_threads: { data: [], error: null } });
    expect(await listHomeCgoThreads(client, TENANT, USER)).toEqual([]);
    expect(calls.some((c) => c.table === "agent_runs")).toBe(false);
  });
});

describe("mergeByActivity", () => {
  it("orders by last activity and keeps the 50 cap", () => {
    const own = Array.from({ length: 50 }, (_, i) => ({ id: `c${i}`, last_message_at: `2026-10-01T00:00:${String(i).padStart(2, "0")}Z` }));
    const home = [{ id: "h1", last_message_at: "2026-10-21T00:00:00Z", from_home: true }];
    const out = mergeByActivity(own, home);
    expect(out).toHaveLength(50);
    expect(out[0]!.id).toBe("h1");
    expect(out.some((r) => r.id === "c0")).toBe(false);
  });
});
