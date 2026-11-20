import { describe, expect, it, vi } from "vitest";
import { assertKnownColumns, selectedColumns } from "@/__tests__/helpers/migration-columns";

const calls = vi.hoisted(() => ({
  log: [] as Array<{ table: string; op: string; args: unknown[] }>,
  rows: {} as Record<string, unknown[]>,
  results: [] as Array<{ data: unknown; error: unknown }>,
}));

vi.mock("@/services/tenant-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/tenant-client")>()),
  asTenantId: (t: string) => t,
  tenantClient: () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      for (const op of ["select", "eq", "in", "or", "like", "is", "order", "limit", "insert", "update", "delete", "maybeSingle"]) {
        q[op] = (...args: unknown[]) => {
          calls.log.push({ table, op, args });
          return q;
        };
      }
      q.then = (resolve: (v: unknown) => void) => resolve(calls.results.shift() ?? { data: calls.rows[table] ?? [], error: null });
      return q;
    },
  }),
}));

import { SEND_CLAIM_ROUTE, SEND_CLAIM_TABLE, supabaseStudioStore } from "../store";

describe("the gallery reads agent_runs by the columns the table really has", () => {
  it("selects and orders runs by enqueued_at, never a created_at agent_runs does not have, and maps it to the video date", async () => {
    calls.rows.agent_runs = [{ id: "r1", enqueued_at: "2026-10-15T10:00:00Z", enqueued_by: "u1", payload: { studio_thread_id: "t1" } }];
    const store = supabaseStudioStore("11111111-1111-4111-8111-111111111111");
    const runs = await store.listVideoRuns!(300);
    const ops = calls.log.filter((c) => c.table === "agent_runs");
    const select = ops.find((c) => c.op === "select")!.args[0] as string;
    expect(select).toContain("enqueued_at");
    expect(select).not.toContain("created_at");
    expect(ops.find((c) => c.op === "order")!.args[0]).toBe("enqueued_at");
    expect(runs).toEqual([{ id: "r1", created_at: "2026-10-15T10:00:00Z", enqueued_by: "u1", studio_thread_id: "t1", intent: null }]);
  });

  it("labels each run with the kind of video it made: from the ad's draft for an Overview video, from the card for a channel video", async () => {
    calls.log.length = 0;
    calls.rows.agent_runs = [
      { id: "r-studio", enqueued_at: "2026-10-15T10:00:00Z", enqueued_by: "u1", payload: { studio_thread_id: "t1", draft_message_id: "m1" } },
      { id: "r-retry", enqueued_at: "2026-10-15T09:00:00Z", enqueued_by: "u1", payload: { studio_thread_id: "t1", draft_message_id: "m1", retry_of: "r-studio" } },
      { id: "r-card", enqueued_at: "2026-10-14T10:00:00Z", enqueued_by: null, payload: {} },
      { id: "r-split", enqueued_at: "2026-10-14T09:00:00Z", enqueued_by: null, payload: null },
      { id: "r-unknown", enqueued_at: "2026-10-13T09:00:00Z", enqueued_by: null, payload: { studio_thread_id: "t2", draft_message_id: "m-gone" } },
    ];
    calls.rows.agent_thread_messages = [{ id: "m1", intent: "animate" }];
    calls.rows.channel_actions = [
      { run_id: "r-card", intent: "talking_head" },
      { run_id: "r-split", intent: "cinematic" },
      { run_id: "r-split", intent: "social" },
      { run_id: "r-card", intent: "not-a-kind" },
    ];
    const runs = await supabaseStudioStore("11111111-1111-4111-8111-111111111111").listVideoRuns!(300);
    expect(runs.map((r) => [r.id, r.intent])).toEqual([
      ["r-studio", "animate"],
      ["r-retry", "animate"],
      ["r-card", "talking_head"],
      ["r-split", null],
      ["r-unknown", null],
    ]);
    const msgIn = calls.log.find((c) => c.table === "agent_thread_messages" && c.op === "in")!.args;
    expect(msgIn).toEqual(["id", ["m1", "m-gone"]]);
    const cardIn = calls.log.find((c) => c.table === "channel_actions" && c.op === "in")!.args;
    expect(cardIn).toEqual(["run_id", ["r-card", "r-split"]]);
    const cardSelect = calls.log.find((c) => c.table === "channel_actions" && c.op === "select")!.args[0] as string;
    assertKnownColumns("channel_actions", selectedColumns(cardSelect));
    assertKnownColumns("channel_actions", calls.log.filter((c) => c.table === "channel_actions" && ["in", "eq"].includes(c.op)).map((c) => String(c.args[0])));
    expect(cardSelect).toContain("exec_payload->intake->>intent");
    for (const t of ["agent_thread_messages", "channel_actions"]) {
      expect(calls.log.find((c) => c.table === t && c.op === "select")!.args[0]).not.toMatch(/\bmeta\b,|\bbody\b,|\*/);
    }
    delete calls.rows.agent_thread_messages;
    delete calls.rows.channel_actions;
  });

  it("a failed label read still lists every video, just without a label", async () => {
    calls.results.push(
      { data: [{ id: "r1", enqueued_at: "2026-10-15T10:00:00Z", enqueued_by: "u1", payload: { studio_thread_id: "t1", draft_message_id: "m1" } }, { id: "r2", enqueued_at: "2026-10-15T09:00:00Z", enqueued_by: null, payload: {} }], error: null },
      { data: null, error: { message: "boom" } },
      { data: null, error: { message: "boom" } },
    );
    const runs = await supabaseStudioStore("11111111-1111-4111-8111-111111111111").listVideoRuns!(300);
    expect(runs.map((r) => [r.id, r.intent])).toEqual([["r1", null], ["r2", null]]);
  });
});

describe("Try again reads the run's own messages, however old", () => {
  it("asks for the rendering row and any failure posted for that run in that ad, not the latest page of the thread", async () => {
    calls.log.length = 0;
    calls.rows.agent_thread_messages = [{ id: "m9", sender_role: "assistant", body: "x", meta: {}, agent_run_id: "r1", created_at: "2026-10-01T00:00:00Z" }];
    const rows = await supabaseStudioStore("11111111-1111-4111-8111-111111111111").listRunMessages!("t1", "00000000-0000-4000-8000-000000000001");
    expect(rows).toHaveLength(1);
    const ops = calls.log.filter((c) => c.table === "agent_thread_messages");
    expect(ops.map((c) => c.op)).not.toContain("limit");
    expect(ops.find((c) => c.op === "eq")!.args).toEqual(["thread_id", "t1"]);
    expect(ops.find((c) => c.op === "or")!.args[0]).toBe("agent_run_id.eq.00000000-0000-4000-8000-000000000001,meta->>source_run_id.eq.00000000-0000-4000-8000-000000000001");
    delete calls.rows.agent_thread_messages;
  });

  it("never builds a filter from a run id that is not a uuid", async () => {
    calls.log.length = 0;
    const rows = await supabaseStudioStore("11111111-1111-4111-8111-111111111111").listRunMessages!("t1", "x,id.neq.0");
    expect(rows).toEqual([]);
    expect(calls.log.filter((c) => c.op === "or")).toEqual([]);
  });
});

describe("the send claim is a row keyed by the table's primary key, never a read-then-write", () => {
  const T = "11111111-1111-4111-8111-111111111111";
  const at = (op: string) => calls.log.filter((c) => c.table === SEND_CLAIM_TABLE && c.op === op);

  it("claims by inserting the key, and a primary-key clash means another send holds it", async () => {
    calls.log.length = 0;
    const claims = supabaseStudioStore(T).sendClaims!;
    calls.results.push({ data: null, error: null });
    const token = await claims.claim("u1", "k1");
    expect(token).toEqual(expect.any(String));
    expect(at("insert")[0].args[0]).toMatchObject({ user_id: "u1", route: SEND_CLAIM_ROUTE, idem_key: "k1", status: "in_progress", created_at: token });
    calls.results.push({ data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } });
    expect(await claims.claim("u1", "k1")).toBeNull();
    calls.results.push({ data: null, error: { code: "08006", message: "connection lost" } });
    await expect(claims.claim("u1", "k1")).rejects.toThrow("connection lost");
  });

  it("taking over, settling and releasing only touch the row this request saw, by its created_at", async () => {
    calls.log.length = 0;
    const claims = supabaseStudioStore(T).sendClaims!;
    calls.results.push({ data: [], error: null });
    expect(await claims.takeOver("u1", "k1", "2026-10-19T10:00:00.000Z")).toBeNull();
    expect(at("eq").map((c) => c.args)).toEqual(
      expect.arrayContaining([["user_id", "u1"], ["route", SEND_CLAIM_ROUTE], ["idem_key", "k1"], ["created_at", "2026-10-19T10:00:00.000Z"]]),
    );
    calls.results.push({ data: [{ idem_key: "k1" }], error: null });
    expect(await claims.takeOver("u1", "k1", "2026-10-19T10:00:00.000Z")).toEqual(expect.any(String));
    calls.log.length = 0;
    calls.results.push({ data: null, error: null });
    await claims.settle("u1", "k1", "tok", { thread_id: "t1" });
    expect(at("update")[0].args[0]).toMatchObject({ status: "done", response_body: { thread_id: "t1" } });
    expect(at("eq").map((c) => c.args)).toContainEqual(["created_at", "tok"]);
    calls.log.length = 0;
    calls.results.push({ data: null, error: null });
    await claims.release("u1", "k1", "tok");
    expect(at("delete")).toHaveLength(1);
    expect(at("eq").map((c) => c.args)).toContainEqual(["created_at", "tok"]);
  });
});

describe("Create reopens the chat with the latest activity, not the newest empty one", () => {
  const T = "11111111-1111-4111-8111-111111111111";
  const orders = () => calls.log.filter((c) => c.table === "agent_threads" && c.op === "order").map((c) => c.args);

  it.each([
    ["findThread", (s: ReturnType<typeof supabaseStudioStore>) => s.findThread("u1")],
    ["listThreads", (s: ReturnType<typeof supabaseStudioStore>) => s.listThreads!("u1", 50)],
  ] as const)("%s sorts by the last message first, with never-used chats after used ones", async (_name, read) => {
    calls.log.length = 0;
    await read(supabaseStudioStore(T));
    expect(orders()).toEqual([
      ["last_message_at", { ascending: false, nullsFirst: false }],
      ["created_at", { ascending: false }],
    ]);
  });
});
