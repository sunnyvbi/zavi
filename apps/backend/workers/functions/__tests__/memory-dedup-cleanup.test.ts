import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  page: [] as Array<Record<string, unknown>>,
  neighborRows: [] as Array<Record<string, unknown>>,
  neighbors: {} as Record<string, Array<Record<string, unknown>>>,
  answers: [] as Array<{ pair_idx: number; duplicate: boolean }>,
  rpc: [] as Array<Record<string, unknown>>,
  verdicts: [] as Array<Record<string, unknown>>,
  logged: [] as Array<Record<string, unknown>>,
  deletes: 0,
}));

vi.mock("../../client", () => ({ inngest: { createFunction: () => ({}) } }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      const filters: string[] = [];
      const b: Record<string, unknown> = {};
      for (const f of ["select", "eq", "is", "not", "or", "order", "limit"]) b[f] = (c: string) => (filters.push(`${f}:${c}`), b);
      b.in = (c: string) => (filters.push(`in:${c}`), b);
      b.delete = () => ((H.deletes += 1), b);
      b.insert = (row: Record<string, unknown>) => {
        if (table === "dream_cycle_verdicts") H.verdicts.push(row);
        return Promise.resolve({ error: null });
      };
      b.then = (res: (v: unknown) => unknown) => {
        if (table === "memory_note") return res({ data: filters.includes("in:id") ? H.neighborRows : H.page, error: null });
        return res({ data: [], error: null });
      };
      return b;
    },
    rpc: async (_fn: string, args: Record<string, unknown>) => {
      H.rpc.push(args);
      return { error: null };
    },
  }),
}));
vi.mock("@/services/anthropic", () => ({
  DEFAULT_MODEL: "m",
  getAnthropic: () => ({
    messages: {
      create: async () => ({
        usage: { input_tokens: 100, output_tokens: 10 },
        content: [{ type: "text", text: JSON.stringify({ answers: H.answers }) }],
      }),
    },
  }),
}));
vi.mock("@/services/memory", () => ({
  PRIVATE_NOTE_TYPES_PGREST_IN: "(agent_experience,agent_procedural)",
  findNearestNeighbors: vi.fn(async (_t: string, _e: number[], o: { excludeNoteId: string }) => H.neighbors[o.excludeNoteId] ?? []),
}));
vi.mock("@/services/memory/embed", () => ({ embedTexts: vi.fn(async (t: string[]) => t.map(() => [0.1])) }));
vi.mock("@/services/memory/write-path", () => ({
  recordWrites: vi.fn(async (_t: string, e: Array<Record<string, unknown>>) => {
    H.logged.push(...e);
  }),
}));

import { pickKeeper, eligiblePair, cleanupPage, type CleanupNote } from "../memory-dedup-cleanup";

const T = "11111111-1111-1111-1111-111111111111";
const note = (id: string, over: Partial<CleanupNote> = {}): CleanupNote => ({
  id,
  title: "Primary geo",
  body_markdown: "Our primary geo is the California Bay Area.",
  note_type: "tenant_reference",
  source: "auto_distill_chat",
  trust_tier: 2,
  value_kind: null,
  created_at: `2026-09-0${id.length}T00:00:00Z`,
  ...over,
});

beforeEach(() => {
  H.page = [];
  H.neighborRows = [];
  H.neighbors = {};
  H.answers = [];
  H.rpc = [];
  H.verdicts = [];
  H.logged = [];
  H.deletes = 0;
});

describe("pickKeeper / eligiblePair", () => {
  it("keeps the higher-trust note, then the older one", () => {
    const a = note("a", { trust_tier: 2, created_at: "2026-09-01" });
    const b = note("b", { trust_tier: 0, created_at: "2026-09-05" });
    expect(pickKeeper(a, b).keep.id).toBe("b");
    const c = note("c", { created_at: "2026-09-01" });
    const d = note("d", { created_at: "2026-09-05" });
    expect(pickKeeper(c, d)).toEqual({ keep: c, drop: d });
  });

  it("never touches id / money / rate facts", () => {
    expect(eligiblePair(note("a", { body_markdown: "Take rate is 15%" }), note("b", { body_markdown: "Take rate is 15%" }))).toBeNull();
    expect(eligiblePair(note("a"), note("b", { value_kind: "id" }))).toBeNull();
  });

  it("different values are never duplicates", () => {
    expect(eligiblePair(note("a", { body_markdown: "We have 612 hosts." }), note("b", { body_markdown: "We have 700 hosts." }))).toBeNull();
  });

  it("an operator-authored note is never the one dropped", () => {
    const human = note("h", { source: "human", created_at: "2026-09-09", trust_tier: 2 });
    const auto = note("x", { created_at: "2026-09-01", trust_tier: 0 });
    expect(eligiblePair(auto, human)).toEqual({ keep: human, drop: auto });
    expect(eligiblePair(human, note("y", { source: "human" }))).toBeNull();
  });
});

describe("cleanupPage", () => {
  it("supersedes the duplicate (never deletes), logs it restorably, records the verdict", async () => {
    H.page = [note("aa", { created_at: "2026-09-01T00:00:00Z" })];
    H.neighbors = { aa: [{ note_id: "bbb", cosine: 0.95 }] };
    H.neighborRows = [{ ...note("bbb", { created_at: "2026-09-03T00:00:00Z" }), superseded_by: null, archived_at: null, slug: null }];
    H.answers = [{ pair_idx: 0, duplicate: true }];
    const r = await cleanupPage(T, null, { usd: 2, changes: 200 });
    expect(r.changed).toBe(1);
    expect(H.rpc[0]).toMatchObject({ p_tenant_id: T, p_new_id: "aa", p_existing_id: "bbb", p_verdict: "KEEP_NEW" });
    expect(H.deletes).toBe(0);
    expect(H.logged[0]).toMatchObject({ action: "cleanup_superseded", note_id: "bbb", matched_note_id: "aa", source: "memory_cleanup" });
    expect(H.verdicts[0]).toMatchObject({ verdict: "KEEP_NEW", new_note_id: "aa", existing_note_id: "bbb" });
  });

  it("a 'not duplicate' answer changes nothing but is recorded so it is not asked again", async () => {
    H.page = [note("aa")];
    H.neighbors = { aa: [{ note_id: "bbb", cosine: 0.95 }] };
    H.neighborRows = [{ ...note("bbb"), superseded_by: null, archived_at: null, slug: null }];
    H.answers = [{ pair_idx: 0, duplicate: false }];
    const r = await cleanupPage(T, null, { usd: 2, changes: 200 });
    expect(r.changed).toBe(0);
    expect(H.rpc).toHaveLength(0);
    expect(H.verdicts[0]).toMatchObject({ verdict: "NO_CONFLICT" });
  });

  it("stops at the change cap", async () => {
    H.page = [note("aa")];
    H.neighbors = { aa: [{ note_id: "bbb", cosine: 0.95 }] };
    H.neighborRows = [{ ...note("bbb"), superseded_by: null, archived_at: null, slug: null }];
    H.answers = [{ pair_idx: 0, duplicate: true }];
    const r = await cleanupPage(T, null, { usd: 2, changes: 0 });
    expect(r).toMatchObject({ changed: 0, done: true });
    expect(H.rpc).toHaveLength(0);
  });
});
