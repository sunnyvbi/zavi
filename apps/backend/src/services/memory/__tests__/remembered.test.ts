import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const H = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  rpc: { data: null as unknown, error: null as { message: string; code?: string } | null },
  rpcCalls: [] as Array<{ tid: string; name: string; args: Record<string, unknown> }>,
  deleted: [] as string[],
  written: [] as Array<Record<string, unknown>>,
  unsuperseded: [] as string[],
  nextId: 0,
  deleteThrows: false,
}));

function makeTable(tid: string, table: string) {
  const filters: Array<(r: Row) => boolean> = [(r) => r.tenant_id === tid];
  let op: "select" | "update" | "insert" = "select";
  let payload: Row | Row[] | null = null;
  let order: { col: string; asc: boolean } | null = null;
  let limit = Infinity;
  const rows = () => (H.db[table] ??= []);
  const run = () => {
    if (op === "insert") {
      const arr = (Array.isArray(payload) ? payload : [payload]) as Row[];
      const inserted = arr.map((r) => ({ id: `gen-${++H.nextId}`, state: "pending", attempts: 0, ...r, tenant_id: tid }));
      rows().push(...inserted);
      return inserted;
    }
    let hit = rows().filter((r) => filters.every((f) => f(r)));
    if (op === "update") {
      hit.forEach((r) => Object.assign(r, payload));
      return hit;
    }
    if (order) {
      const { col, asc } = order;
      hit = [...hit].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (asc ? 1 : -1));
    }
    return hit.slice(0, limit);
  };
  const b: Record<string, unknown> = {
    select: () => b,
    eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
    in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), b),
    is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), b),
    not: (c: string, _o: string, _v: unknown) => (filters.push((r) => r[c] != null), b),
    gte: (c: string, v: string) => (filters.push((r) => String(r[c]) >= v), b),
    lte: (c: string, v: string) => (filters.push((r) => String(r[c]) <= v), b),
    lt: (c: string, v: string) => (filters.push((r) => String(r[c]) < v), b),
    or: (expr: string) => {
      const groups = expr.match(/and\(([^)]*)\)|[^,()]+/g) ?? [];
      const preds = groups.map((g) => {
        const inner = g.startsWith("and(") ? g.slice(4, -1) : g;
        const conds = inner.split(",").map((c) => {
          const [col, op, ...rest] = c.split(".");
          const val = rest.join(".").replace(/^"|"$/g, "");
          return (r: Row) =>
            op === "eq" ? String(r[col]) === val
            : op === "lte" ? String(r[col]) <= val
            : op === "is" ? (r[col] ?? null) === null
            : false;
        });
        return (r: Row) => conds.every((f) => f(r));
      });
      filters.push((r) => preds.some((p) => p(r)));
      return b;
    },
    order: (col: string, o?: { ascending?: boolean }) => ((order = { col, asc: o?.ascending !== false }), b),
    limit: (n: number) => ((limit = n), b),
    update: (p: Row) => ((op = "update"), (payload = p), b),
    insert: (p: Row | Row[]) => ((op = "insert"), (payload = p), b),
    maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
    single: async () => ({ data: run()[0] ?? null, error: null }),
    then: (res: (v: unknown) => unknown) => res({ data: run(), error: null }),
  };
  return b;
}

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantClient: (tid: string) => ({ from: (t: string) => makeTable(tid, t) }),
  tenantRpc: (tid: string, name: string, args: Record<string, unknown>) => {
    H.rpcCalls.push({ tid, name, args });
    if (name === "memory_undo_forget") {
      const graceMs = Number(args.p_grace_seconds ?? 0) * 1000;
      const req = (H.db.memory_forget_request ?? []).find(
        (r) =>
          r.id === args.p_request_id &&
          r.tenant_id === tid &&
          r.state === "pending" &&
          String(r.undo_expires_at) >= new Date(Date.now() - graceMs).toISOString(),
      );
      if (!req) return Promise.resolve({ data: false, error: null });
      const n = (H.db.memory_note ?? []).find((x) => x.id === req.note_id && x.tenant_id === tid && x.forgotten_at);
      if (!n) return Promise.resolve({ data: false, error: null });
      Object.assign(n, { archived_at: null, archive_reason: null, forgotten_at: null });
      req.state = "undone";
      return Promise.resolve({ data: true, error: null });
    }
    return Promise.resolve(H.rpc);
  },
}));
vi.mock("@/services/logging/log-review", () => ({ logReview: vi.fn() }));
vi.mock("../index", () => ({
  NoteNotFoundError: class NoteNotFoundError extends Error {},
  deleteNote: vi.fn(async (tid: string, id: string) => {
    if (H.deleteThrows) throw new Error("fk violation");
    H.deleted.push(id);
    H.db.memory_note = (H.db.memory_note ?? []).filter((n) => !(n.id === id && n.tenant_id === tid));
  }),
  unsupersedeNote: vi.fn(async (_t: string, id: string) => {
    H.unsuperseded.push(id);
  }),
  writeNote: vi.fn(async (_t: string, input: Record<string, unknown>) => {
    H.written.push(input);
    return { note_id: "restored-note", chunks: 1, entities: 0 };
  }),
}));

import {
  forgetNote,
  getRunWrites,
  keepConflictValue,
  listOpenConflicts,
  listRecentWrites,
  purgeForgetRequest,
  restoreWrite,
  undoForget,
  undoUpdate,
} from "../remembered";

const A = "tenant-a";
const B = "tenant-b";
const past = (ms: number) => new Date(Date.now() - ms).toISOString();

beforeEach(() => {
  H.db = {
    memory_note: [
      { id: "n-new", tenant_id: A, title: "Launch month", body_markdown: "The India launch moved to July.", archived_at: null, forgotten_at: null, slug: null },
      { id: "n-old", tenant_id: A, title: "Launch month", body_markdown: "June.", archived_at: null, forgotten_at: null, slug: null },
      { id: "n-rate2", tenant_id: A, title: "Take rate", body_markdown: "18%", archived_at: null, forgotten_at: null, slug: null },
      { id: "n-rate1", tenant_id: A, title: "Take rate", body_markdown: "15%", archived_at: null, forgotten_at: null, slug: null },
      { id: "n-anchor", tenant_id: A, title: "Company", body_markdown: "x", archived_at: null, forgotten_at: null, slug: "company" },
      { id: "n-b", tenant_id: B, title: "Other tenant", body_markdown: "secret", archived_at: null, forgotten_at: null, slug: null },
    ],
    agent_runs: [
      { id: "run-1", tenant_id: A, distilled_at: past(1000), finished_at: past(2000) },
      { id: "run-2", tenant_id: A, distilled_at: null, finished_at: past(1000) },
      { id: "run-3", tenant_id: A, distilled_at: null, finished_at: past(60 * 60 * 1000) },
      { id: "run-b", tenant_id: B, distilled_at: past(1000), finished_at: past(1000) },
    ],
    agent_thread_messages: [{ id: "msg-1", tenant_id: A, agent_run_id: "run-1" }],
    memory_write_log: [
      { id: "l1", tenant_id: A, run_id: "run-1", thread_id: "th-1", action: "updated", note_id: "n-new", matched_note_id: "n-old", restored_at: null, created_at: past(900) },
      { id: "l2", tenant_id: A, run_id: "run-1", thread_id: "th-1", action: "conflict", note_id: "n-rate2", matched_note_id: "n-rate1", restored_at: null, created_at: past(800) },
      { id: "l3", tenant_id: A, run_id: "run-1", action: "duplicate", note_id: null, matched_note_id: "n-old", candidate_title: "Launch", candidate_body: "June launch", candidate_note_type: "tenant_project", restored_at: null, created_at: past(700) },
      { id: "l4", tenant_id: B, run_id: "run-b", action: "added", note_id: "n-b", restored_at: null, created_at: past(600) },
    ],
    memory_conflict_pair: [
      { id: "pair-1", tenant_id: A, existing_note_id: "n-rate1", new_note_id: "n-rate2", status: "open", subject: "take rate", attribute: "value", created_at: past(800) },
    ],
    memory_forget_request: [],
  };
  H.rpc = { data: null, error: null };
  H.rpcCalls = [];
  H.deleted = [];
  H.written = [];
  H.unsuperseded = [];
  H.deleteThrows = false;
});

describe("getRunWrites (the Remembered pill)", () => {
  it("lists what a run saved, with the replaced note and the open pair", async () => {
    const out = await getRunWrites(A, { run_id: "run-1" });
    expect(out!.status).toBe("done");
    expect(out!.items).toEqual([
      { note_id: "n-new", kind: "updated", title: "Launch month", body_excerpt: "The India launch moved to July.", previous: { note_id: "n-old", title: "Launch month", body_excerpt: "June." } },
      { note_id: "n-rate2", kind: "conflict", title: "Take rate", body_excerpt: "18%", conflict_with: { note_id: "n-rate1", title: "Take rate", body_excerpt: "15%" }, pair_id: "pair-1", pair_status: "open" },
    ]);
  });

  it("resolves a reply's thread_message_id to its run", async () => {
    const out = await getRunWrites(A, { thread_message_id: "msg-1" });
    expect(out!.items).toHaveLength(2);
  });

  it("pending until the distill ran; done once the wait has run out", async () => {
    expect((await getRunWrites(A, { run_id: "run-2" }))!.status).toBe("pending");
    expect((await getRunWrites(A, { run_id: "run-3" }))!.status).toBe("done");
  });

  it("another tenant's run is not found", async () => {
    expect(await getRunWrites(A, { run_id: "run-b" })).toBeNull();
    expect(await getRunWrites(B, { thread_message_id: "msg-1" })).toBeNull();
  });

  it("a forgotten note drops out of the pill", async () => {
    (H.db.memory_note.find((n) => n.id === "n-new") as Row).forgotten_at = past(1);
    const out = await getRunWrites(A, { run_id: "run-1" });
    expect(out!.items.map((i) => i.note_id)).toEqual(["n-rate2"]);
  });
});

describe("listRecentWrites", () => {
  it("is tenant-wide, newest first, with the source run and thread", async () => {
    const items = await listRecentWrites(A, { since: past(10_000), limit: 10 });
    expect(items.map((i) => i.note_id)).toEqual(["n-rate2", "n-new"]);
    expect(items[0].source).toEqual({ run_id: "run-1", thread_id: "th-1" });
    expect(items.some((i) => i.note_id === "n-b")).toBe(false);
  });
});

describe("Forget", () => {
  it("hides the note at once, returns an undo token, and undo brings it back", async () => {
    const r = await forgetNote(A, "n-new", "user-1");
    expect(r.ok).toBe(true);
    const note = H.db.memory_note.find((n) => n.id === "n-new")!;
    expect(note.archived_at).toBeTruthy();
    expect(note.forgotten_at).toBeTruthy();
    const token = (r as { undo_token: string }).undo_token;
    expect(await undoForget(A, token)).toBe(true);
    expect(note.archived_at).toBeNull();
    expect(note.forgotten_at).toBeNull();
    expect(await undoForget(A, token)).toBe(false);
  });

  it("another tenant cannot forget or undo", async () => {
    expect(await forgetNote(B, "n-new", "u")).toEqual({ ok: false, code: "not_found" });
    const r = (await forgetNote(A, "n-new", "u")) as { undo_token: string };
    expect(await undoForget(B, r.undo_token)).toBe(false);
  });

  it("anchors are not forgettable", async () => {
    expect(await forgetNote(A, "n-anchor", "u")).toEqual({ ok: false, code: "anchor" });
  });

  it("undo after the window is refused", async () => {
    const r = (await forgetNote(A, "n-new", "u")) as { undo_token: string };
    (H.db.memory_forget_request[0] as Row).undo_expires_at = past(60_000);
    expect(await undoForget(A, r.undo_token)).toBe(false);
  });

  it("the purge waits for its time, then scrubs the skip log and hard-deletes", async () => {
    const r = (await forgetNote(A, "n-old", "u")) as { undo_token: string };
    expect(await purgeForgetRequest(A, r.undo_token)).toBe("not_due");
    (H.db.memory_forget_request[0] as Row).purge_after = past(1);
    expect(await purgeForgetRequest(A, r.undo_token)).toBe("purged");
    expect(H.deleted).toEqual(["n-old"]);
    expect((H.db.memory_forget_request[0] as Row).resolved_at).toBeTruthy();
    const l3 = H.db.memory_write_log.find((l) => l.id === "l3")!;
    expect(l3.candidate_body).toBeNull();
    const l1 = H.db.memory_write_log.find((l) => l.id === "l1")!;
    expect(l1.candidate_body ?? null).toBeNull();
    expect(await undoForget(A, r.undo_token)).toBe(false);
  });

  it("a failing purge never gives up: back to pending with a later due time, still hidden", async () => {
    const r = (await forgetNote(A, "n-old", "u")) as { undo_token: string };
    const req = H.db.memory_forget_request[0] as Row;
    req.purge_after = past(1);
    req.attempts = 7;
    H.deleteThrows = true;
    expect(await purgeForgetRequest(A, r.undo_token)).toBe("retry");
    expect(req.state).toBe("pending");
    expect(req.attempts).toBe(8);
    expect(String(req.purge_after) > new Date().toISOString()).toBe(true);
    expect(H.db.memory_note.find((n) => n.id === "n-old")!.forgotten_at).toBeTruthy();
  });

  it("a claim left in progress by a double failure is claimed again once stale", async () => {
    const r = (await forgetNote(A, "n-old", "u")) as { undo_token: string };
    const req = H.db.memory_forget_request[0] as Row;
    Object.assign(req, { state: "purged", resolved_at: null, purge_after: past(1) });
    expect(await purgeForgetRequest(A, r.undo_token)).toBe("purged");
    expect(H.deleted).toEqual(["n-old"]);
  });

  it("undo is refused when the note was deleted meanwhile", async () => {
    const r = (await forgetNote(A, "n-old", "u")) as { undo_token: string };
    H.db.memory_note = H.db.memory_note.filter((n) => n.id !== "n-old");
    expect(await undoForget(A, r.undo_token)).toBe(false);
    expect((H.db.memory_forget_request[0] as Row).state).toBe("pending");
  });

  it("an undone forget is never purged", async () => {
    const r = (await forgetNote(A, "n-old", "u")) as { undo_token: string };
    await undoForget(A, r.undo_token);
    (H.db.memory_forget_request[0] as Row).purge_after = past(1);
    expect(await purgeForgetRequest(A, r.undo_token)).toBe("not_due");
    expect(H.deleted).toEqual([]);
  });
});

describe("undo update / conflicts / restore", () => {
  it("undo-update goes through the tenant-scoped RPC", async () => {
    H.rpc = { data: "n-old", error: null };
    expect(await undoUpdate(A, "n-new")).toBe("n-old");
    expect(H.rpcCalls[0]).toEqual({ tid: A, name: "memory_undo_update", args: { p_new_note_id: "n-new" } });
  });

  it("keep maps the RPC's answers", async () => {
    H.rpc = { data: true, error: null };
    expect(await keepConflictValue(A, "pair-1", "n-rate1", "u")).toBe("kept");
    H.rpc = { data: false, error: null };
    expect(await keepConflictValue(A, "pair-1", "n-rate1", "u")).toBe("not_open");
    H.rpc = { data: null, error: { message: "note_not_in_pair", code: "22023" } };
    expect(await keepConflictValue(A, "pair-1", "n-x", "u")).toBe("not_in_pair");
    expect(H.rpcCalls[0].args).toEqual({ p_pair_id: "pair-1", p_keep_note_id: "n-rate1", p_user_id: "u" });
  });

  it("lists open pairs in the contract shape", async () => {
    const pairs = await listOpenConflicts(A, {});
    expect(pairs).toEqual([
      {
        pair_id: "pair-1",
        subject: "take rate",
        attribute: "value",
        created_at: expect.any(String),
        values: [
          { note_id: "n-rate1", title: "Take rate", body_excerpt: "15%" },
          { note_id: "n-rate2", title: "Take rate", body_excerpt: "18%" },
        ],
      },
    ]);
    expect(await listOpenConflicts(B, {})).toEqual([]);
  });

  it("restores a wrongly skipped duplicate as the user's own note, once", async () => {
    expect(await restoreWrite(A, "l3")).toBe("restored");
    expect(H.written[0]).toMatchObject({ body_markdown: "June launch", note_type: "tenant_project", source: "human", trust_tier: 0 });
    expect(await restoreWrite(A, "l3")).toBe("already_restored");
    expect(await restoreWrite(B, "l3")).toBe("not_found");
  });
});
