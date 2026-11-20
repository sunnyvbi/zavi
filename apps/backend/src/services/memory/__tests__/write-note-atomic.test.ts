import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  ops: [] as Array<{ table: string; op: string; payload?: unknown; filters: Array<[string, unknown]> }>,
  embedFails: false,
  chunkInsertError: null as { message: string } | null,
  noteRow: null as Record<string, unknown> | null,
  pairs: [] as Array<Record<string, unknown>>,
  partnerNotes: [] as Array<Record<string, unknown>>,
}));

vi.mock("../embed", () => ({
  EMBED_DIM: 2,
  VoyageError: class VoyageError extends Error {},
  VoyageDimError: class VoyageDimError extends Error {},
  embedTexts: vi.fn(async (texts: string[]) => {
    if (H.embedFails) throw new Error("voyage 503");
    return texts.map(() => [0.1, 0.2]);
  }),
  embedOne: vi.fn(async () => [0.1, 0.2]),
}));
vi.mock("../contextualize", () => ({
  contextualizeChunks: vi.fn((chunks: string[]) => chunks.map((c) => ({ body: c, contextualized: c }))),
}));
vi.mock("../extract", () => ({
  extractEntities: vi.fn(() => ({ entities: [] })),
  extractEntitiesAndRelations: vi.fn(async () => ({ entities: [], relations: [] })),
}));
vi.mock("../llm-entity-extract-flag", () => ({ isLlmEntityExtractEnabledForTenant: vi.fn(async () => false) }));
vi.mock("../valid-time", () => ({
  maybeExtractValidTime: vi.fn(async () => null),
  closeValidInterval: vi.fn(),
  factHoldsAtValidTime: vi.fn(() => true),
}));
vi.mock("../conflict-resolution", () => ({ maybeResolveConflict: vi.fn(async () => null) }));
vi.mock("@/services/logging/log-review", () => ({ logReview: vi.fn() }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      const rec = { table, op: "select", payload: undefined as unknown, filters: [] as Array<[string, unknown]> };
      H.ops.push(rec);
      const b: Record<string, unknown> = {};
      b.select = () => b;
      for (const f of ["eq", "is", "order", "limit", "in", "neq", "or"]) {
        b[f] = (col: string, val: unknown) => {
          rec.filters.push([`${f}:${col}`, val]);
          return b;
        };
      }
      b.insert = (payload: unknown) => {
        rec.op = "insert";
        rec.payload = payload;
        return b;
      };
      b.update = (payload: unknown) => {
        rec.op = "update";
        rec.payload = payload;
        return b;
      };
      b.delete = () => {
        rec.op = "delete";
        return b;
      };
      b.single = async () => ({ data: { id: "note-1" }, error: null });
      b.maybeSingle = async () => ({ data: table === "memory_note" ? H.noteRow : null, error: null });
      b.then = (res: (v: unknown) => unknown) => {
        if (table === "memory_chunk" && rec.op === "insert") return res({ error: H.chunkInsertError });
        if (table === "memory_conflict_pair") return res({ data: H.pairs, error: null });
        if (table === "memory_note" && rec.op === "select") return res({ data: H.partnerNotes, error: null });
        return res({ data: null, error: null });
      };
      return b;
    },
    rpc: async () => ({ data: null, error: null }),
  }),
}));

import { writeNote, finishPendingNote, annotateOpenConflicts, CONFLICT_RECALL_LABEL, type SearchHit } from "../index";

const T = "11111111-1111-1111-1111-111111111111";

const noteInsert = () => H.ops.find((o) => o.table === "memory_note" && o.op === "insert");
const stateUpdates = () =>
  H.ops.filter((o) => o.table === "memory_note" && o.op === "update").map((o) => o.payload as Record<string, unknown>);

beforeEach(() => {
  H.ops = [];
  H.embedFails = false;
  H.chunkInsertError = null;
  H.noteRow = null;
  H.pairs = [];
  H.partnerNotes = [];
});

describe("writeNote: enrichment state", () => {
  it("inserts the note 'pending' with its gate keys, then flips it to 'done'", async () => {
    const r = await writeNote(T, {
      title: "Pixel",
      body_markdown: "The Meta pixel ID is 1234567890.",
      note_type: "tenant_reference",
      subject: "meta pixel",
      attribute: "id",
      value_kind: "id",
      source_class: "user_stated",
    });
    expect(noteInsert()!.payload).toMatchObject({
      enrichment_state: "pending",
      subject: "meta pixel",
      attribute: "id",
      value_kind: "id",
      source_class: "user_stated",
    });
    expect(stateUpdates()).toContainEqual({ enrichment_state: "done", enrichment_attempts: 0 });
    expect(r.enrichment).toBeUndefined();
    expect(r.chunks).toBe(1);
  });

  it("a Voyage outage leaves the note pending (chunks land without embeddings), never 'done'", async () => {
    H.embedFails = true;
    const r = await writeNote(T, { title: "Geo", body_markdown: "Primary geo is California.", note_type: "tenant_reference" });
    expect(r.enrichment).toBe("pending");
    expect(stateUpdates().some((u) => u.enrichment_state === "done")).toBe(false);
  });

  it("a chunk-insert error does not throw: the note row exists and stays pending", async () => {
    H.chunkInsertError = { message: "deadlock" };
    const r = await writeNote(T, { title: "Geo", body_markdown: "Primary geo is California.", note_type: "tenant_reference" });
    expect(r).toMatchObject({ note_id: "note-1", chunks: 0, enrichment: "pending" });
  });

  it("writes outside the gate leave the key columns untouched", async () => {
    await writeNote(T, { title: "Geo", body_markdown: "Primary geo is California." });
    const p = noteInsert()!.payload as Record<string, unknown>;
    expect(p).not.toHaveProperty("subject");
    expect(p).not.toHaveProperty("source_class");
  });
});

describe("finishPendingNote", () => {
  it("rebuilds chunks from the stored row and marks it done", async () => {
    H.noteRow = { id: "n1", title: "Geo", note_type: "tenant_reference", body_markdown: "CA", enrichment_state: "pending", enrichment_attempts: 1 };
    expect(await finishPendingNote(T, "n1")).toBe("done");
    expect(H.ops.some((o) => o.table === "memory_chunk" && o.op === "delete")).toBe(true);
  });

  it("gives up after 5 attempts", async () => {
    H.noteRow = { id: "n1", title: "Geo", note_type: "tenant_reference", body_markdown: "CA", enrichment_state: "pending", enrichment_attempts: 4 };
    H.embedFails = true;
    expect(await finishPendingNote(T, "n1")).toBe("failed");
    expect(stateUpdates()).toContainEqual({ enrichment_state: "failed", enrichment_attempts: 5 });
  });

  it("skips a note that is no longer pending", async () => {
    H.noteRow = { id: "n1", enrichment_state: "done" };
    expect(await finishPendingNote(T, "n1")).toBe("skipped");
  });
});

describe("annotateOpenConflicts", () => {
  const hit = (id: string, score = 0.5): SearchHit => ({ chunk_id: `c-${id}`, note_id: id, title: id, body: `body ${id}`, score });

  it("labels both sides of an open pair and brings in the missing side", async () => {
    H.pairs = [{ existing_note_id: "a", new_note_id: "b" }];
    H.partnerNotes = [{ id: "b", title: "B", body_markdown: "value two", source: "auto_distill_chat", note_type: "tenant_reference", created_at: "x", trust_tier: 0, agent_slug: null, thread_id: null }];
    const out = await annotateOpenConflicts(T, [hit("a", 0.8), hit("z")]);
    expect(out.map((h) => h.note_id)).toEqual(["a", "z", "b"]);
    expect(out[0].body.startsWith(CONFLICT_RECALL_LABEL)).toBe(true);
    expect(out[0].conflict).toBe(true);
    expect(out[1].conflict).toBeUndefined();
    expect(out[2]).toMatchObject({ note_id: "b", conflict: true, score: 0.8 });
    const pairQuery = H.ops.find((o) => o.table === "memory_conflict_pair")!;
    expect(pairQuery.filters).toContainEqual(["eq:tenant_id", T]);
    expect(pairQuery.filters).toContainEqual(["eq:status", "open"]);
  });

  it("returns hits unchanged with no open pairs, and never queries for an empty result", async () => {
    const hits = [hit("a")];
    expect(await annotateOpenConflicts(T, hits)).toBe(hits);
    H.ops = [];
    expect(await annotateOpenConflicts(T, [])).toEqual([]);
    expect(H.ops).toHaveLength(0);
  });
});
