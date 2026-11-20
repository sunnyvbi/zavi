import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  runRow: null as Record<string, unknown> | null,
  page: [] as Array<Record<string, unknown>>,
  neighbors: {} as Record<string, Array<Record<string, unknown>>>,
  meta: [] as Array<Record<string, unknown>>,
  prior: [] as Array<Record<string, unknown>>,
  verdicts: [] as Array<{ pair_idx: number; verdict: string; rationale: string }>,
  opusThrows: false,
  opusText: null as string | null,
  cursorWriteFails: false,
  embedThrows: false,
  ops: [] as Array<{ table: string; op: string; payload?: unknown; filters: Array<[string, unknown]> }>,
  rpc: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  logged: [] as unknown[],
}));

vi.mock("../../client", () => ({ inngest: { createFunction: () => ({}) } }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      const rec = { table, op: "select", payload: undefined as unknown, filters: [] as Array<[string, unknown]> };
      H.ops.push(rec);
      const b: Record<string, unknown> = {};
      b.select = () => b;
      for (const f of ["eq", "is", "in", "not", "or", "gt", "order", "limit"]) {
        b[f] = (col: string, val: unknown) => {
          rec.filters.push([`${f}:${col}`, val]);
          return b;
        };
      }
      b.insert = (p: unknown) => {
        rec.op = "insert";
        rec.payload = p;
        return Promise.resolve({ error: null });
      };
      b.upsert = (p: unknown) => {
        rec.op = "upsert";
        rec.payload = p;
        return Promise.resolve({ error: H.cursorWriteFails ? { message: "write failed" } : null });
      };
      b.maybeSingle = async () => ({ data: table === "dream_cycle_runs" ? H.runRow : null, error: null });
      b.then = (res: (v: unknown) => unknown) => {
        if (table === "memory_note") {
          const isMeta = rec.filters.some(([k]) => k === "in:id");
          return res({ data: isMeta ? H.meta : H.page, error: null });
        }
        if (table === "dream_cycle_verdicts") return res({ data: H.prior, error: null });
        return res({ data: [], error: null });
      };
      return b;
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      H.rpc.push({ fn, args });
      return { error: null };
    },
  }),
}));
vi.mock("@/services/anthropic", () => ({
  DEFAULT_MODEL: "m",
  getAnthropic: () => ({
    messages: {
      create: async () => {
        if (H.opusThrows) throw new Error("529 overloaded");
        return {
          usage: { input_tokens: 1000, output_tokens: 100 },
          content: [{ type: "text", text: H.opusText ?? JSON.stringify({ verdicts: H.verdicts }) }],
        };
      },
    },
  }),
}));
vi.mock("@/services/memory", () => ({
  PRIVATE_NOTE_TYPES_PGREST_IN: "(agent_experience,agent_procedural)",
  findNearestNeighbors: vi.fn(async (_t: string, _e: number[], opts: { excludeNoteId: string }) => H.neighbors[opts.excludeNoteId] ?? []),
}));
vi.mock("@/services/memory/embed", () => ({
  embedTexts: vi.fn(async (texts: string[]) => {
    if (H.embedThrows) throw new Error("voyage down");
    return texts.map(() => [0.1]);
  }),
}));
vi.mock("@/services/memory/valid-time", () => ({
  isValidTimeEnabledForTenant: vi.fn(async () => false),
  closeValidInterval: vi.fn(),
}));
vi.mock("@/services/memory/write-path", () => ({
  recordWrites: vi.fn(async (_t: string, e: unknown[]) => {
    H.logged.push(...e);
  }),
}));

import { dreamCyclePage } from "../dream-cycle";

const T = "11111111-1111-1111-1111-111111111111";
const note = (id: string, created_at: string, over: Record<string, unknown> = {}) => ({
  id, title: `t-${id}`, body_markdown: `Primary geo is California (${id})`, note_type: "tenant_reference",
  created_at, trust_tier: 2, subject: null, attribute: null, value_kind: null, ...over,
});
const hit = (id: string, cosine = 0.9) => ({ note_id: id, title: `t-${id}`, body_markdown: "Primary geo is California", note_type: "tenant_reference", cosine, created_at: "x" });

const cursorUpserts = () =>
  H.ops.filter((o) => o.table === "dream_cycle_runs" && o.op === "upsert").map((o) => o.payload as Record<string, unknown>);

beforeEach(() => {
  H.runRow = { cursor_created_at: "2026-09-28T00:00:00Z", cursor_note_id: "n0", last_completed_at: null };
  H.page = [];
  H.neighbors = {};
  H.meta = [];
  H.prior = [];
  H.verdicts = [];
  H.opusThrows = false;
  H.opusText = null;
  H.cursorWriteFails = false;
  H.embedThrows = false;
  H.ops = [];
  H.rpc = [];
  H.logged = [];
});

describe("dreamCyclePage", () => {
  it("reads strictly after the (created_at, id) cursor", async () => {
    await dreamCyclePage(T, 1);
    const read = H.ops.find((o) => o.table === "memory_note")!;
    expect(read.filters).toContainEqual([
      "or:created_at.gt.\"2026-09-28T00:00:00Z\",and(created_at.eq.\"2026-09-28T00:00:00Z\",id.gt.n0)",
      undefined,
    ]);
  });

  it("a new tenant's starting cursor is stored before any work, so an early stop cannot skip the page", async () => {
    H.runRow = null;
    H.page = [note("n1", "2026-09-29T01:00:00Z")];
    H.embedThrows = true;
    await dreamCyclePage(T, 1);
    expect(cursorUpserts()).toEqual([expect.objectContaining({ cursor_created_at: expect.any(String) })]);
    expect(cursorUpserts()[0]).not.toHaveProperty("cursor_note_id");
  });

  it("an empty page is done and moves nothing", async () => {
    const r = await dreamCyclePage(T, 1);
    expect(r).toMatchObject({ done: true, scanned: 0 });
    expect(cursorUpserts()).toHaveLength(0);
  });

  it("advances the cursor to the last note of a fully judged page, and auto-applies a duplicate", async () => {
    H.page = [note("n1", "2026-09-29T01:00:00Z"), note("n2", "2026-09-29T02:00:00Z")];
    H.neighbors = { n1: [hit("old-1")] };
    H.meta = [{ id: "old-1", trust_tier: 2, subject: null, attribute: null, value_kind: null }];
    H.verdicts = [{ pair_idx: 0, verdict: "KEEP_OLD", rationale: "same fact" }];
    const r = await dreamCyclePage(T, 1);
    expect(r).toMatchObject({ scanned: 2, pairs: 1, auto_applied: 1 });
    expect(cursorUpserts()).toEqual([
      expect.objectContaining({ cursor_created_at: "2026-09-29T02:00:00Z", cursor_note_id: "n2" }),
    ]);
    expect(H.rpc[0]).toMatchObject({ fn: "apply_dream_verdict", args: { p_verdict: "KEEP_OLD", p_new_id: "n1", p_existing_id: "old-1" } });
    expect(H.logged).toEqual([
      expect.objectContaining({ action: "cleanup_superseded", note_id: "n1", matched_note_id: "old-1", source: "dream_cycle" }),
    ]);
  });

  it("never stages for staff: a held verdict is only logged", async () => {
    H.page = [note("n1", "2026-09-29T01:00:00Z")];
    H.neighbors = { n1: [hit("old-1")] };
    H.meta = [{ id: "old-1", trust_tier: 2, subject: null, attribute: null, value_kind: null }];
    H.verdicts = [{ pair_idx: 0, verdict: "KEEP_NEW", rationale: "newer" }];
    const r = await dreamCyclePage(T, 1);
    expect(r).toMatchObject({ auto_applied: 0, held: 1 });
    expect(H.rpc).toHaveLength(0);
    expect(H.ops.some((o) => o.table === "dream_candidates")).toBe(false);
    const logged = H.ops.find((o) => o.table === "dream_cycle_verdicts" && o.op === "insert")!;
    expect(logged.payload).toMatchObject({ verdict: "KEEP_NEW", new_note_id: "n1" });
  });

  it("an id / money / rate pair is never auto-applied", async () => {
    H.page = [note("n1", "2026-09-29T01:00:00Z", { body_markdown: "Take rate is 15%" })];
    H.neighbors = { n1: [hit("old-1")] };
    H.meta = [{ id: "old-1", trust_tier: 2 }];
    H.verdicts = [{ pair_idx: 0, verdict: "KEEP_OLD", rationale: "dup" }];
    const r = await dreamCyclePage(T, 1);
    expect(r.auto_applied).toBe(0);
    expect(H.rpc).toHaveLength(0);
  });

  it("an Opus failure stops without moving the cursor past unjudged notes", async () => {
    H.page = [note("n1", "2026-09-29T01:00:00Z"), note("n2", "2026-09-29T02:00:00Z")];
    H.neighbors = { n1: [hit("old-1")] };
    H.meta = [{ id: "old-1", trust_tier: 2, subject: null, attribute: null, value_kind: null }];
    H.opusThrows = true;
    const r = await dreamCyclePage(T, 1);
    expect(r.done).toBe(true);
    expect(cursorUpserts()).toHaveLength(0);
  });

  it("malformed model output stops without logging verdicts or moving the cursor", async () => {
    H.page = [note("n1", "2026-09-29T01:00:00Z")];
    H.neighbors = { n1: [hit("old-1")] };
    H.meta = [{ id: "old-1", trust_tier: 2, subject: null, attribute: null, value_kind: null }];
    H.opusText = '{"verdicts": [{"pair_idx": 0, "verd';
    const r = await dreamCyclePage(T, 1);
    expect(r.done).toBe(true);
    expect(cursorUpserts()).toHaveLength(0);
    expect(H.ops.some((o) => o.table === "dream_cycle_verdicts" && o.op === "insert")).toBe(false);
  });

  it("a new tenant whose starting cursor cannot be stored does no page work", async () => {
    H.runRow = null;
    H.cursorWriteFails = true;
    H.page = [note("n1", "2026-09-29T01:00:00Z")];
    await expect(dreamCyclePage(T, 1)).rejects.toThrow(/cursor/);
    expect(H.ops.some((o) => o.table === "memory_note")).toBe(false);
  });

  it("a pair the model left without a verdict is logged SKIPPED (no change) and never stalls the cursor", async () => {
    H.page = [note("n1", "2026-09-29T01:00:00Z"), note("n2", "2026-09-29T02:00:00Z")];
    H.neighbors = { n1: [hit("old-1")], n2: [hit("old-2")] };
    H.meta = [
      { id: "old-1", trust_tier: 2, subject: null, attribute: null, value_kind: null },
      { id: "old-2", trust_tier: 2, subject: null, attribute: null, value_kind: null },
    ];
    H.verdicts = [{ pair_idx: 0, verdict: "NO_CONFLICT", rationale: "fine" }];
    await dreamCyclePage(T, 1);
    expect(cursorUpserts()).toEqual([expect.objectContaining({ cursor_note_id: "n2" })]);
    const logged = H.ops.filter((o) => o.table === "dream_cycle_verdicts" && o.op === "insert");
    expect(logged.map((o) => (o.payload as { verdict: string }).verdict)).toEqual(["NO_CONFLICT", "SKIPPED"]);
    expect(H.rpc).toHaveLength(0);
  });

  it("skips pairs already judged, read in ONE query for the page", async () => {
    H.page = [note("n1", "2026-09-29T01:00:00Z")];
    H.neighbors = { n1: [hit("old-1")] };
    H.prior = [{ new_note_id: "n1", existing_note_id: "old-1" }];
    const r = await dreamCyclePage(T, 1);
    expect(r.pairs).toBe(0);
    expect(H.ops.filter((o) => o.table === "dream_cycle_verdicts" && o.op === "select")).toHaveLength(1);
  });

  it("an embed outage stops the page and keeps the cursor", async () => {
    H.page = [note("n1", "2026-09-29T01:00:00Z")];
    H.embedThrows = true;
    const r = await dreamCyclePage(T, 1);
    expect(r.done).toBe(true);
    expect(cursorUpserts()).toHaveLength(0);
  });
});
