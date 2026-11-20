import { beforeEach, describe, expect, it, vi } from "vitest";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "99999999-9999-4999-8999-999999999999";
const USER = "22222222-2222-4222-8222-222222222222";
const OTHER_USER = "88888888-8888-4888-8888-888888888888";
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const T1 = "cccccccc-0000-4000-8000-000000000003";
const T2 = "dddddddd-0000-4000-8000-000000000004";
const T3 = "eeeeeeee-0000-4000-8000-000000000005";
const T4 = "ffffffff-0000-4000-8000-000000000006";

type Row = Record<string, unknown>;
type Filter = [string, string, unknown];

const h = vi.hoisted(() => ({
  settings: {} as Record<string, boolean | "throw">,
  db: { conductor_runs: [] as Row[], agent_threads: [] as Row[], agent_runs: [] as Row[] },
  reads: [] as Array<{ table: string; filters: Array<[string, string, unknown]> }>,
}));

function cell(row: Row, col: string): unknown {
  const path = /^payload->>(\w+)$/.exec(col);
  if (path) {
    const v = (row.payload as Row | null | undefined)?.[path[1]!];
    return v === undefined || v === null ? null : String(v);
  }
  return row[col] ?? null;
}

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every(([op, col, val]) => {
    if (op === "eq") return cell(row, col) === val;
    if (op === "is") return cell(row, col) === val;
    if (op === "not_is_null") return cell(row, col) !== null;
    if (op === "in") return (val as unknown[]).includes(cell(row, col));
    return true;
  });
}

function query(table: string, rls: boolean) {
  const filters: Filter[] = [];
  let order: { col: string; asc: boolean } | null = null;
  let cap = Infinity;
  const visible = () =>
    (h.db as Record<string, Row[]>)[table]!.filter((row) =>
      !rls ? true : row.tenant_id === TENANT && (table !== "agent_threads" || row.user_id === USER),
    );
  const run = () => {
    h.reads.push({ table, filters: [...filters] });
    let rows = visible().filter((row) => matches(row, filters));
    if (order) {
      const { col, asc } = order;
      rows = [...rows].sort((a, b) => (String(a[col]) < String(b[col]) ? (asc ? -1 : 1) : asc ? 1 : -1));
    }
    return { data: rows.slice(0, cap), error: null };
  };
  const api: Record<string, unknown> = {
    select: () => api,
    eq: (col: string, val: unknown) => (filters.push(["eq", col, val]), api),
    is: (col: string, val: unknown) => (filters.push(["is", col, val]), api),
    in: (col: string, vals: unknown[]) => (filters.push(["in", col, vals]), api),
    not: (col: string, op: string, val: unknown) => {
      if (op === "is" && val === null) filters.push(["not_is_null", col, null]);
      return api;
    },
    order: (col: string, o?: { ascending?: boolean }) => ((order = { col, asc: o?.ascending !== false }), api),
    limit: (n: number) => ((cap = n), api),
    maybeSingle: async () => {
      const r = run();
      return { data: (r.data as Row[])[0] ?? null, error: null };
    },
    then: (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, bad),
  };
  return api;
}

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: async () => ({ tenant_id: TENANT, user_id: USER, access_token: "tok" }),
}));
vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({ from: (table: string) => query(table, true) }),
  serviceClient: () => ({ from: (table: string) => query(table, false) }),
}));
vi.mock("@/services/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/settings")>()),
  getBoolSetting: async (key: string) => {
    const v = h.settings[key];
    if (v === "throw") throw new Error("settings read failed");
    return v ?? true;
  },
}));

import { getAutopilotBuildSessions } from "../autopilot";
import { buildChatThreadIds } from "@/services/build/build-chat-thread";
import { buildSessionOfThread, mustForkThread, type BindingDb } from "@/services/agents/build-session-binding";
import { serverClientFromBearer } from "@/services/supabase";

const fakeServiceDb = () => ({ from: (table: string) => query(table, false) }) as unknown as BindingDb;

function res() {
  const r = {
    statusCode: 200,
    body: undefined as any,
    status(c: number) {
      r.statusCode = c;
      return r;
    },
    json(b: unknown) {
      r.body = b;
      return r;
    },
  };
  return r;
}

const thread = (id: string, extra: Row = {}): Row => ({
  id,
  tenant_id: TENANT,
  user_id: USER,
  agent_slug: "operator",
  deleted_at: null,
  last_message_at: "2026-10-01T10:00:00Z",
  ...extra,
});

let clock = 0;
function turn(threadId: string, session: string | null, extra: Row = {}): void {
  clock += 1;
  h.db.agent_runs.push({
    id: `run-${clock}`,
    tenant_id: TENANT,
    agent_slug: "operator",
    enqueued_by: USER,
    enqueued_at: new Date(Date.UTC(2026, 9, 1, 10) + clock * 1000).toISOString(),
    payload: session ? { thread_id: threadId, build_session_id: session } : { thread_id: threadId },
    ...extra,
  });
}

function forkingSend(session: string, sentThread: string | null, freshThread: string): Promise<string> {
  return (async () => {
    const svc = fakeServiceDb();
    let target = sentThread;
    if (target && mustForkThread(session, await buildSessionOfThread(svc, TENANT, target))) target = null;
    const landed = target ?? freshThread;
    if (!h.db.agent_threads.some((t) => t.id === landed)) h.db.agent_threads.push(thread(landed));
    turn(landed, session);
    return landed;
  })();
}

const linked = () => buildChatThreadIds(serverClientFromBearer("tok") as never, TENANT, USER);

beforeEach(() => {
  clock = 0;
  h.settings = {};
  h.reads = [];
  h.db.conductor_runs = [];
  h.db.agent_threads = [];
  h.db.agent_runs = [];
});

describe("DEL-1323 B26: a build's chat is read from the build_session_id chat-send stamps on each run", () => {
  it("when chat-send forks a thread away from another build, the list follows the fork and never points at the old thread", async () => {
    const first = await forkingSend(A, null, T1);
    expect(first).toBe(T1);
    const forked = await forkingSend(B, T1, T2);
    expect(forked).toBe(T2);
    const map = await linked();
    expect(map.get(A)).toEqual([T1]);
    expect(map.get(B)).toEqual([T2]);
    const svc = fakeServiceDb();
    for (const [session, threads] of map) {
      for (const t of threads) {
        expect(mustForkThread(session, await buildSessionOfThread(svc, TENANT, t))).toBe(false);
      }
    }
    const again = await forkingSend(B, map.get(B)![0]!, T3);
    expect(again).toBe(T2);
  });

  it("a thread is listed under the build of its newest bound turn only, matching the fork check", async () => {
    h.db.agent_threads.push(thread(T1));
    turn(T1, A);
    turn(T1, null);
    turn(T1, B);
    const map = await linked();
    expect(map.get(B)).toEqual([T1]);
    expect(map.has(A)).toBe(false);
    expect(await buildSessionOfThread(fakeServiceDb(), TENANT, T1)).toBe(B);
  });

  it("lists only this user's own live operator threads, newest first, and ignores other tenants' runs", async () => {
    h.db.agent_threads.push(
      thread(T1, { last_message_at: "2026-10-01T09:00:00Z" }),
      thread(T2, { last_message_at: "2026-10-01T12:00:00Z" }),
      thread(T3, { deleted_at: "2026-10-01T13:00:00Z" }),
      thread(T4, { user_id: OTHER_USER }),
      thread("abababab-0000-4000-8000-000000000007", { agent_slug: "engineer" }),
    );
    turn(T1, A);
    turn(T2, A);
    turn(T3, A);
    turn(T4, A);
    turn("abababab-0000-4000-8000-000000000007", A);
    turn("cdcdcdcd-0000-4000-8000-000000000008", B, { tenant_id: OTHER_TENANT });
    turn(T1, "not-a-uuid");
    const map = await linked();
    expect([...map.entries()]).toEqual([[A, [T2, T1]]]);
  });

  it("a busy workspace: hundreds of newer build-bound runs from teammates and child agents never push this user's older build chat out", async () => {
    h.db.agent_threads.push(thread(T1));
    turn(T1, A);
    for (let i = 0; i < 260; i++) {
      const other = `0000${String(i).padStart(4, "0")}-0000-4000-8000-000000000000`;
      h.db.agent_threads.push(thread(other, { user_id: OTHER_USER }));
      turn(other, B, { enqueued_by: OTHER_USER });
      turn(other, B, { agent_slug: "engineer", enqueued_by: null });
    }
    const map = await linked();
    expect([...map.entries()]).toEqual([[A, [T1]]]);
    const runRead = h.reads.find((r) => r.table === "agent_runs")!;
    expect(runRead.filters).toEqual(
      expect.arrayContaining([
        ["eq", "tenant_id", TENANT],
        ["eq", "agent_slug", "operator"],
        ["eq", "enqueued_by", USER],
      ]),
    );
  });

  it("reads no threads at all when no run was ever sent from a build", async () => {
    h.db.agent_threads.push(thread(T1));
    turn(T1, null);
    expect((await linked()).size).toBe(0);
    expect(h.reads.map((r) => r.table)).toEqual(["agent_runs"]);
  });
});

describe("GET build-sessions carries each build's own chat", () => {
  const session = (id: string, created: string): Row => ({
    id,
    tenant_id: TENANT,
    kind: "build_app",
    objective: "Build product: Bikes — b",
    status: "done",
    created_at: created,
    updated_at: created,
  });

  beforeEach(() => {
    h.db.conductor_runs = [session(A, "2026-10-01T09:00:00Z"), session(B, "2026-10-01T08:00:00Z")];
  });

  async function sessions() {
    const r = res();
    await getAutopilotBuildSessions({ query: {} } as never, r as never);
    return r.body as { sessions: Array<{ id: string; chat_thread_ids?: string[] }>; ui_flags: Record<string, boolean> };
  }

  it("returns the forked thread on the build it was forked for, and the old thread stays on its own build", async () => {
    await forkingSend(A, null, T1);
    await forkingSend(B, T1, T2);
    const body = await sessions();
    const byId = Object.fromEntries(body.sessions.map((s) => [s.id, s]));
    expect(byId[A]!.chat_thread_ids).toEqual([T1]);
    expect(byId[B]!.chat_thread_ids).toEqual([T2]);
    expect(body.ui_flags.chat_thread_follows_build).toBe(true);
  });

  it("a build with no bound turn carries no chat_thread_ids key", async () => {
    await forkingSend(A, null, T1);
    const body = await sessions();
    const byId = Object.fromEntries(body.sessions.map((s) => [s.id, s]));
    expect("chat_thread_ids" in byId[B]!).toBe(false);
  });

  it("with the setting off or unreadable it never reads runs or threads and reports it off", async () => {
    await forkingSend(A, null, T1);
    for (const value of [false, "throw"] as const) {
      h.settings.build_chat_thread_follows_build = value;
      h.reads = [];
      const body = await sessions();
      expect(body.sessions.every((s) => !("chat_thread_ids" in s))).toBe(true);
      expect(h.reads.some((r) => r.table === "agent_threads" || r.table === "agent_runs")).toBe(false);
      expect(body.ui_flags.chat_thread_follows_build).toBe(false);
    }
  });
});
