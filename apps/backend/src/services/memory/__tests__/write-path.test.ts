import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  tables: {} as Record<string, unknown[]>,
  rpc: { data: [] as unknown[], error: null as { message: string } | null },
  rpcCalls: [] as Array<{ tid: string; name: string; args: Record<string, unknown> }>,
  inserts: [] as Array<{ table: string; rows: unknown }>,
  upserts: [] as Array<{ table: string; rows: unknown; opts: unknown }>,
  filters: [] as Array<{ table: string; op: string; col: string; val: unknown }>,
  embedThrows: false,
  upsertError: null as { message: string } | null,
}));

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantClient: (tid: string) => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      const chain = (op: string) => (col: string, val: unknown) => {
        H.filters.push({ table, op, col, val });
        return b;
      };
      b.select = () => {
        H.filters.push({ table, op: "tenant", col: "tenant_id", val: tid });
        return b;
      };
      for (const op of ["eq", "in", "is", "order", "limit"]) b[op] = chain(op);
      b.then = (res: (v: unknown) => unknown) => res({ data: H.tables[table] ?? [], error: null });
      b.insert = (rows: unknown) => {
        H.inserts.push({ table, rows });
        return Promise.resolve({ error: null });
      };
      b.upsert = (rows: unknown, opts: unknown) => {
        H.upserts.push({ table, rows, opts });
        return Promise.resolve({ error: H.upsertError });
      };
      return b;
    },
  }),
  tenantRpc: (tid: string, name: string, args: Record<string, unknown>) => {
    H.rpcCalls.push({ tid, name, args });
    return Promise.resolve(H.rpc);
  },
}));
vi.mock("../embed", () => ({
  embedOne: vi.fn(async () => {
    if (H.embedThrows) throw new Error("voyage down");
    return [0.1, 0.2];
  }),
}));
vi.mock("../index", () => ({ PRIVATE_NOTE_TYPE_SET: new Set(["agent_experience", "agent_procedural"]) }));

import {
  loadExistingFacts,
  recordWrites,
  supersedeForUpdate,
  openConflictPair,
  recalledNoteIdsForRun,
  UPDATE_RATIONALE,
} from "../write-path";

const T = "11111111-1111-1111-1111-111111111111";
const RUN = "22222222-2222-2222-2222-222222222222";
const N1 = "aaaaaaaa-0000-0000-0000-000000000001";
const N2 = "aaaaaaaa-0000-0000-0000-000000000002";
const N3 = "aaaaaaaa-0000-0000-0000-000000000003";

beforeEach(() => {
  H.tables = {};
  H.rpc = { data: [], error: null };
  H.rpcCalls = [];
  H.inserts = [];
  H.upserts = [];
  H.filters = [];
  H.embedThrows = false;
  H.upsertError = null;
});

describe("recalledNoteIdsForRun", () => {
  it("unions the notes every search in the run returned, first-seen order, uuids only", async () => {
    H.tables.memory_search_trace = [
      { rank_components: { returned_notes: [{ id: N1, score: 0.9 }, { id: "not-a-uuid" }] } },
      { rank_components: { returned_notes: [{ id: N2 }, { id: N1 }] } },
      { rank_components: null },
    ];
    expect(await recalledNoteIdsForRun(T, RUN)).toEqual([N1, N2]);
  });

  it("rejects a non-uuid run id without querying", async () => {
    expect(await recalledNoteIdsForRun(T, "x")).toEqual([]);
    expect(H.filters).toHaveLength(0);
  });
});

describe("loadExistingFacts", () => {
  it("recalled notes come first as R refs, neighbors as E refs, no repeats, no private notes", async () => {
    H.tables.memory_search_trace = [{ rank_components: { returned_notes: [{ id: N1 }, { id: N3 }] } }];
    H.tables.memory_note = [
      { id: N1, title: "Rate", body_markdown: "15%", note_type: "tenant_reference", subject: "take rate", attribute: "value", value_kind: "rate", source_class: "user_stated", trust_tier: 0 },
      { id: N3, title: "Mine", body_markdown: "x", note_type: "agent_procedural", subject: null, attribute: null, value_kind: null, source_class: null, trust_tier: 0 },
    ];
    H.rpc.data = [
      { note_id: N1, title: "Rate", body_excerpt: "15%", note_type: "tenant_reference", trust_tier: 0 },
      { note_id: N2, title: "Geo", body_excerpt: "CA", note_type: "tenant_reference", subject: null, attribute: null, value_kind: "bogus", source_class: null, trust_tier: null },
    ];
    const facts = await loadExistingFacts(T, { queryText: "take rate", run_id: RUN });
    expect(facts.map((f) => [f.ref, f.note_id, f.recalled])).toEqual([
      ["R1", N1, true],
      ["E1", N2, false],
    ]);
    expect(facts[0]).toMatchObject({ subject: "take rate", value_kind: "rate", trust_tier: 0 });
    expect(facts[1]).toMatchObject({ value_kind: null, trust_tier: 2 });
    expect(H.rpcCalls[0]).toMatchObject({ tid: T, name: "memory_fact_neighbors", args: { p_limit: 8 } });
    expect(H.filters.filter((f) => f.op === "tenant").every((f) => f.val === T)).toBe(true);
  });

  it("fails soft: an embed outage still returns the recalled notes", async () => {
    H.tables.memory_search_trace = [{ rank_components: { returned_notes: [{ id: N1 }] } }];
    H.tables.memory_note = [{ id: N1, title: "Rate", body_markdown: "15%", note_type: "tenant_reference", trust_tier: 2 }];
    H.embedThrows = true;
    const facts = await loadExistingFacts(T, { queryText: "q", run_id: RUN });
    expect(facts.map((f) => f.ref)).toEqual(["R1"]);
  });

  it("no query text and no run: no lookups at all", async () => {
    expect(await loadExistingFacts(T, { queryText: "  " })).toEqual([]);
    expect(H.rpcCalls).toHaveLength(0);
  });
});

describe("recordWrites / supersede / conflict", () => {
  it("writes the whole call's log in ONE insert and drops non-uuid ids", async () => {
    await recordWrites(T, [
      { source: "auto_distill_chat", action: "added", run_id: RUN, note_id: N1, candidate_title: "a", candidate_body: "b" },
      { source: "auto_distill_chat", action: "duplicate", run_id: "bogus", matched_note_id: N2 },
    ]);
    expect(H.inserts).toHaveLength(1);
    const rows = H.inserts[0].rows as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[1].run_id).toBeNull();
  });

  it("no entries, no insert", async () => {
    await recordWrites(T, []);
    expect(H.inserts).toHaveLength(0);
  });

  it("an update supersedes through the tenant-scoped RPC with the undo-able rationale", async () => {
    expect(await supersedeForUpdate(T, N2, N1)).toBe(true);
    expect(H.rpcCalls[0]).toEqual({
      tid: T,
      name: "apply_dream_verdict",
      args: { p_new_id: N2, p_existing_id: N1, p_verdict: "KEEP_NEW", p_rationale: UPDATE_RATIONALE },
    });
    expect(UPDATE_RATIONALE.startsWith("memory-write: updated")).toBe(true);
    expect(await supersedeForUpdate(T, N1, N1)).toBe(false);
  });

  it("a conflict pair insert failure is thrown, so the distill retries instead of leaving an unanswerable conflict", async () => {
    H.upsertError = { message: "deadlock" };
    await expect(
      openConflictPair(T, { existing_note_id: N1, new_note_id: N2, subject: null, attribute: null, reason: "protected_value" }),
    ).rejects.toThrow(/conflict pair insert failed/);
  });

  it("a conflict pair upsert is idempotent on (tenant, existing, new)", async () => {
    await openConflictPair(T, { existing_note_id: N1, new_note_id: N2, subject: "s", attribute: "a", reason: "protected_value", run_id: RUN });
    expect(H.upserts[0].opts).toEqual({ onConflict: "tenant_id,existing_note_id,new_note_id", ignoreDuplicates: true });
  });
});
