import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  markers: new Map<string, number>(),
  failInsert: null as null | "error" | "lost_ack",
  delayMs: 2,
  seq: 0,
}));

function readPath(row: Row, col: string): unknown {
  if (!col.includes("->")) return row[col];
  const parts = col.split(/->>?/);
  let v: unknown = row[parts[0]];
  for (const k of parts.slice(1)) {
    if (!v || typeof v !== "object") return undefined;
    v = (v as Row)[k];
  }
  return col.includes("->>") && v != null && typeof v !== "string" ? String(v) : v;
}

const pause = () => new Promise((r) => setTimeout(r, h.delayMs));

function scoped(tenant: string) {
  return {
    from(table: string) {
      h.tables[table] ??= [];
      const rows = h.tables[table];
      const filters: Array<(r: Row) => boolean> = [(r) => r.tenant_id === tenant];
      let op: "select" | "insert" | "update" = "select";
      let patch: Row | null = null;
      let order: { col: string; asc: boolean } | null = null;
      let limit: number | null = null;
      const run = async () => {
        await pause();
        if (op === "insert") {
          if (h.failInsert === "error") return { data: null, error: { message: "insert failed" } };
          rows.push({ id: `msg-${++h.seq}`, created_at: new Date(Date.now() + h.seq).toISOString(), ...patch, tenant_id: tenant });
          if (h.failInsert === "lost_ack") return { data: null, error: { message: "connection reset" } };
          return { data: null, error: null };
        }
        let hit = rows.filter((r) => filters.every((f) => f(r)));
        if (op === "update") {
          for (const r of hit) Object.assign(r, patch);
          return { data: null, error: null };
        }
        if (order) {
          const { col, asc } = order;
          hit = [...hit].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (asc ? 1 : -1));
        }
        if (limit != null) hit = hit.slice(0, limit);
        return { data: hit.map((r) => ({ ...r })), error: null };
      };
      const b: Record<string, unknown> = {
        select: () => b,
        insert: (p: Row) => {
          op = "insert";
          patch = p;
          return b;
        },
        update: (p: Row) => {
          op = "update";
          patch = p;
          return b;
        },
        eq: (col: string, val: unknown) => {
          filters.push((r) => readPath(r, col) === val);
          return b;
        },
        in: (col: string, vals: unknown[]) => {
          filters.push((r) => vals.includes(readPath(r, col)));
          return b;
        },
        is: (col: string, val: unknown) => {
          filters.push((r) => (readPath(r, col) ?? null) === val);
          return b;
        },
        order: (col: string, o?: { ascending?: boolean }) => {
          order = { col, asc: o?.ascending !== false };
          return b;
        },
        limit: (n: number) => {
          limit = n;
          return b;
        },
        maybeSingle: async () => {
          const { data, error } = await run();
          return { data: Array.isArray(data) ? (data[0] ?? null) : null, error };
        },
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => run().then(res, rej),
      };
      return b;
    },
  };
}

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: (t: string) => scoped(t),
  consumeTenantRateLimit: async (t: string, bucket: string, limit: number) => {
    await pause();
    const key = `tenant:${t}:${bucket}`;
    const count = (h.markers.get(key) ?? 0) + 1;
    h.markers.set(key, count);
    return count <= limit;
  },
  clearTenantMarker: async (t: string, bucket: string) => {
    await pause();
    h.markers.delete(`tenant:${t}:${bucket}`);
  },
}));
vi.mock("@/services/settings", () => ({ getBoolSetting: async () => false }));

import { postBuildReadyMessage, BUILD_READY_IN_PREVIEW } from "../build-ready-message";

const T = "11111111-1111-4111-8111-111111111111";
const SESSION = "aaaaaaaa-0000-4000-8000-000000000001";
const FIX = "bbbbbbbb-0000-4000-8000-000000000002";
const THREAD = "cccccccc-0000-4000-8000-000000000003";
const OTHER_THREAD = "dddddddd-0000-4000-8000-000000000004";

function seed() {
  h.markers.clear();
  h.failInsert = null;
  h.tables = {
    conductor_runs: [
      { id: SESSION, tenant_id: T, kind: "build_app", status: "done", goal_graph: [{ status: "done", payload: { stage: "build" } }] },
      {
        id: FIX,
        tenant_id: T,
        kind: "build_app",
        status: "done",
        goal_graph: [{ status: "done", payload: { stage: "build", refine_mode: true, parent_conductor_run_id: SESSION } }],
      },
    ],
    agent_runs: [
      { id: "r1", tenant_id: T, agent_slug: "operator", enqueued_at: "2026-10-05T10:00:00Z", payload: { thread_id: THREAD, build_session_id: SESSION } },
      { id: "r2", tenant_id: T, agent_slug: "operator", enqueued_at: "2026-10-05T10:05:00Z", payload: { thread_id: OTHER_THREAD } },
    ],
    agent_threads: [
      { id: THREAD, tenant_id: T, agent_slug: "operator", deleted_at: null, last_message_at: "2026-10-05T10:01:00Z" },
      { id: OTHER_THREAD, tenant_id: T, agent_slug: "operator", deleted_at: null, last_message_at: "2026-10-05T10:06:00Z" },
    ],
    agent_thread_messages: [
      { id: "m0", tenant_id: T, thread_id: THREAD, sender_role: "assistant", body: "Your site isn't live yet. It's still being built. Ask me again in a bit.", meta: {} },
    ],
  };
}

const readyMessages = () =>
  (h.tables.agent_thread_messages ?? []).filter((m) => (m.meta as Row | undefined)?.build_ready === true);

beforeEach(seed);

describe("postBuildReadyMessage", () => {
  it("posts one ready message into the build's own thread, after the stale 'not live yet' answer", async () => {
    const out = await postBuildReadyMessage({ tenant_id: T, conductor_run_id: SESSION });

    expect(out).toEqual({ posted: true, thread_id: THREAD });
    const thread = h.tables.agent_thread_messages.filter((m) => m.thread_id === THREAD);
    expect(thread.at(-1)).toMatchObject({ sender_role: "assistant", body: BUILD_READY_IN_PREVIEW, tenant_id: T });
    expect(h.tables.agent_thread_messages.filter((m) => m.thread_id === OTHER_THREAD)).toEqual([]);
  });

  it("two workers racing the same ready transition post exactly one message", async () => {
    const results = await Promise.all([
      postBuildReadyMessage({ tenant_id: T, conductor_run_id: SESSION }),
      postBuildReadyMessage({ tenant_id: T, conductor_run_id: SESSION }),
      postBuildReadyMessage({ tenant_id: T, conductor_run_id: SESSION }),
    ]);

    expect(results.filter((r) => r.posted)).toHaveLength(1);
    expect(results.filter((r) => !r.posted).map((r) => (r as { reason: string }).reason)).toEqual(["already_posted", "already_posted"]);
    expect(readyMessages()).toHaveLength(1);
  });

  it("a retry, a second ready transition and a fix pass going ready again never post a second message", async () => {
    await postBuildReadyMessage({ tenant_id: T, conductor_run_id: SESSION });
    await postBuildReadyMessage({ tenant_id: T, conductor_run_id: SESSION });
    h.tables.conductor_runs[0].status = "active";
    expect(await postBuildReadyMessage({ tenant_id: T, conductor_run_id: SESSION })).toEqual({ posted: false, reason: "not_ready" });
    h.tables.conductor_runs[0].status = "done";
    await Promise.all([
      postBuildReadyMessage({ tenant_id: T, conductor_run_id: SESSION }),
      postBuildReadyMessage({ tenant_id: T, conductor_run_id: FIX }),
    ]);

    expect(readyMessages()).toHaveLength(1);
  });

  it("a failed insert gives the claim back so the next transition still posts, once", async () => {
    h.failInsert = "error";
    expect(await postBuildReadyMessage({ tenant_id: T, conductor_run_id: SESSION })).toEqual({ posted: false, reason: "insert_failed" });
    expect(readyMessages()).toHaveLength(0);

    h.failInsert = null;
    await Promise.all([
      postBuildReadyMessage({ tenant_id: T, conductor_run_id: SESSION }),
      postBuildReadyMessage({ tenant_id: T, conductor_run_id: SESSION }),
    ]);
    expect(readyMessages()).toHaveLength(1);
  });

  it("an insert whose ack was lost keeps the claim, so a retry does not post a duplicate", async () => {
    h.failInsert = "lost_ack";
    await postBuildReadyMessage({ tenant_id: T, conductor_run_id: SESSION });
    h.failInsert = null;
    await postBuildReadyMessage({ tenant_id: T, conductor_run_id: SESSION });

    expect(readyMessages()).toHaveLength(1);
  });

  it("posts nothing and burns no claim when the build has no chat thread, or its thread was deleted", async () => {
    h.tables.agent_threads[0].deleted_at = "2026-10-05T10:02:00Z";
    expect(await postBuildReadyMessage({ tenant_id: T, conductor_run_id: SESSION })).toEqual({ posted: false, reason: "no_thread" });
    expect(h.markers.size).toBe(0);

    h.tables.agent_threads[0].deleted_at = null;
    expect(await postBuildReadyMessage({ tenant_id: T, conductor_run_id: SESSION })).toMatchObject({ posted: true });
    expect(readyMessages()).toHaveLength(1);
  });

  it("never writes into another tenant's thread bound to the same build id", async () => {
    const OTHER = "22222222-2222-4222-8222-222222222222";
    h.tables.agent_runs = [{ id: "x", tenant_id: OTHER, agent_slug: "operator", enqueued_at: "2026-10-05T10:00:00Z", payload: { thread_id: THREAD, build_session_id: SESSION } }];

    expect(await postBuildReadyMessage({ tenant_id: T, conductor_run_id: SESSION })).toEqual({ posted: false, reason: "no_thread" });
    expect(readyMessages()).toHaveLength(0);
  });
});
