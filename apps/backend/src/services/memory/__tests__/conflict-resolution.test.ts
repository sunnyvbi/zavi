import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  classifyConflict,
  maybeResolveConflict,
  parseConflictRelation,
  isDatedSnapshotConflict,
  type ConflictCandidate,
  type ConflictDeps,
  type ConflictRelation,
  type IncomingFact,
} from "../conflict-resolution";

type Neighbor = {
  note_id: string;
  title: string;
  body_markdown: string;
  note_type: string;
  cosine: number;
  created_at: string;
};
const H = vi.hoisted(() => ({
  rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  updateCalls: [] as Array<{ table: string; arg: Record<string, unknown> }>,
  sb: { current: null as unknown },
  neighbors: [] as Neighbor[],
  tierRows: [] as Array<{ id: string; trust_tier: number | null }>,
  tierErr: null as { message: string } | null,
  winnerRow: null as {
    tags: string[] | null;
    metadata: Record<string, unknown> | null;
    connector_object_keys: string[] | null;
    trust_tier: number | null;
    source_ref: string | null;
    thread_id: string | null;
    agent_slug: string | null;
  } | null,
  updateResult: { data: [{ id: "winner" }] as Array<{ id: string }>, error: null as { message: string } | null },
  classifyFn: (_userMsg: string): string => "supersede",
  lastClassifyModel: "" as string,
}));

vi.mock("../embed", () => ({
  EMBED_DIM: 1024,
  VoyageError: class VoyageError extends Error {},
  VoyageDimError: class VoyageDimError extends Error {},
  embedTexts: vi.fn(async (texts: string[]) => texts.map(() => new Array(1024).fill(0.01))),
  embedOne: vi.fn(async () => new Array(1024).fill(0.01)),
}));
vi.mock("../contextualize", () => ({
  contextualizeChunks: vi.fn((chunks: string[]) =>
    chunks.map((c) => ({ body: c, contextualized: c })),
  ),
}));
vi.mock("../extract", () => ({
  extractEntities: vi.fn(() => ({ entities: [] })),
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => H.sb.current,
}));
vi.mock("@/services/settings", () => ({
  getBoolSetting: vi.fn(async () => true),
  getNumberSetting: vi.fn(async () => 0),
  getStringSetting: vi.fn(async () => ""),
}));
vi.mock("@/services/anthropic", () => ({
  DEFAULT_FAST_MODEL: "fast-model",
  getAnthropic: vi.fn(() => ({
    messages: {
      create: vi.fn(async (req: { model?: string; messages: Array<{ content: string }> }) => {
        H.lastClassifyModel = req.model ?? "";
        const userMsg = req.messages?.[0]?.content ?? "";
        return { content: [{ type: "text", text: JSON.stringify({ relation: H.classifyFn(userMsg) }) }] };
      }),
    },
  })),
}));

const TENANT = "11111111-1111-1111-1111-111111111111";

function incoming(over: Partial<IncomingFact> = {}): IncomingFact {
  return {
    title: "Upcar coverage",
    body: "Upcar operates in 7 states.",
    note_type: "untyped",
    ...over,
  };
}

function candidate(over: Partial<ConflictCandidate> = {}): ConflictCandidate {
  return {
    note_id: "note-existing",
    title: "Upcar coverage",
    body: "Upcar operates in 5 states.",
    cosine: 0.92,
    trust_tier: 2,
    ...over,
  };
}

function makeDeps(
  candidates: ConflictCandidate[],
  classifyImpl: (i: IncomingFact, c: ConflictCandidate) => Promise<ConflictRelation>,
) {
  const findCandidates = vi.fn(async () => candidates);
  const classify = vi.fn(classifyImpl);
  const deps: ConflictDeps = { findCandidates, classify };
  return { deps, findCandidates, classify };
}

describe("maybeResolveConflict — flag gate", () => {
  it("flag OFF → null; no embed/search/classify/rpc work (only the cached settings flag read)", async () => {
    const { deps, findCandidates, classify } = makeDeps([candidate()], async () => "supersede");
    const flagCheck = vi.fn(async () => false);

    const result = await maybeResolveConflict(TENANT, incoming(), deps, flagCheck);

    expect(result).toBeNull();
    expect(flagCheck).toHaveBeenCalledTimes(1);
    expect(findCandidates.mock.calls.length).toBe(0);
    expect(classify.mock.calls.length).toBe(0);
  });

  it("flag-store error → null (fail safe to OFF), no work", async () => {
    const { deps, findCandidates, classify } = makeDeps([candidate()], async () => "supersede");
    const flagCheck = vi.fn(async () => {
      throw new Error("settings down");
    });

    const result = await maybeResolveConflict(TENANT, incoming(), deps, flagCheck);

    expect(result).toBeNull();
    expect(findCandidates.mock.calls.length).toBe(0);
    expect(classify.mock.calls.length).toBe(0);
  });

  it("flag ON runs classifyConflict", async () => {
    const { deps } = makeDeps([candidate()], async () => "supersede");
    const flagCheck = vi.fn(async () => true);
    const result = await maybeResolveConflict(TENANT, incoming(), deps, flagCheck);
    expect(result?.relation).toBe("supersede");
  });
});

describe("classifyConflict — supersede with trust guard satisfied", () => {
  it("existing trust_tier >= incoming → 'supersede' + targetNoteId + supersedeTargetIds", async () => {
    const cand = candidate({ note_id: "stale-note", trust_tier: 2, cosine: 0.93 });
    const { deps } = makeDeps([cand], async () => "supersede");

    const d = await classifyConflict(TENANT, incoming({ trust_tier: 2 }), deps);

    expect(d.relation).toBe("supersede");
    expect(d.targetNoteId).toBe("stale-note");
    expect(d.supersedeTargetIds).toEqual(["stale-note"]);
    expect(d.supersedeBlockedByTrust).toBeUndefined();
  });

  it("higher-trust incoming (tier 0) superseding lower-trust existing (tier 2) is allowed", async () => {
    const cand = candidate({ note_id: "agent-belief", trust_tier: 2 });
    const { deps } = makeDeps([cand], async () => "supersede");
    const d = await classifyConflict(TENANT, incoming({ trust_tier: 0 }), deps);
    expect(d.relation).toBe("supersede");
    expect(d.targetNoteId).toBe("agent-belief");
  });
});

describe("classifyConflict — trust guard blocks a bury", () => {
  it("incoming tier 2 vs existing tier 0, LLM says supersede → DOWNGRADE to 'extend', no target", async () => {
    const cand = candidate({ note_id: "operator-fact", trust_tier: 0, cosine: 0.95 });
    const { deps } = makeDeps([cand], async () => "supersede");

    const d = await classifyConflict(TENANT, incoming({ trust_tier: 2 }), deps);

    expect(d.relation).toBe("extend");
    expect(d.targetNoteId).toBeNull();
    expect(d.supersedeTargetIds).toBeUndefined();
    expect(d.supersedeBlockedByTrust).toBe(true);
  });
});

describe("classifyConflict — dated-snapshot guard blocks history destruction", () => {
  it("same slot, DIFFERENT trailing dates, LLM says supersede → DOWNGRADE to 'extend' keep-both", async () => {
    const cand = candidate({
      note_id: "funnel-june",
      title: "Funnel diagnosis — 2026-06-03",
      cosine: 0.87,
    });
    const { deps } = makeDeps([cand], async () => "supersede");

    const d = await classifyConflict(
      TENANT,
      incoming({ title: "Funnel diagnosis — 2026-07-04", trust_tier: 2 }),
      deps,
    );

    expect(d.relation).toBe("extend");
    expect(d.targetNoteId).toBeNull();
    expect(d.supersedeTargetIds).toBeUndefined();
    expect(d.supersedeBlockedByDate).toBe(true);
    expect(d.supersedeBlockedByTrust).toBeUndefined();
  });

  it("same slot, SAME date → still supersedes (legit same-snapshot dedup)", async () => {
    const cand = candidate({
      note_id: "attr-today",
      title: "Growth attribution snapshot — 2026-07-04",
      cosine: 0.93,
    });
    const { deps } = makeDeps([cand], async () => "supersede");

    const d = await classifyConflict(
      TENANT,
      incoming({ title: "Growth attribution snapshot — 2026-07-04", trust_tier: 2 }),
      deps,
    );

    expect(d.relation).toBe("supersede");
    expect(d.supersedeTargetIds).toEqual(["attr-today"]);
    expect(d.supersedeBlockedByDate).toBeUndefined();
  });

  it.each([
    ["Launch deadline is 2026-07-15", "Launch deadline is 2026-08-01"],
    ["Launch deadline: 2026-07-15", "Launch deadline: 2026-08-01"],
    ["Sprint 12 - 2026-07-15", "Sprint 12 - 2026-08-01"],
  ])("date-VALUED fact that changed → still supersedes: %s → %s", async (oldTitle, newTitle) => {
    const cand = candidate({ note_id: "deadline", title: oldTitle, cosine: 0.9 });
    const { deps } = makeDeps([cand], async () => "supersede");

    const d = await classifyConflict(TENANT, incoming({ title: newTitle, trust_tier: 2 }), deps);

    expect(d.relation).toBe("supersede");
    expect(d.supersedeTargetIds).toEqual(["deadline"]);
    expect(d.supersedeBlockedByDate).toBeUndefined();
  });

  it("different-stem progression with no dates → still supersedes (scaffold → build)", async () => {
    const cand = candidate({
      note_id: "scaffold",
      title: "Helpshelf v1 SaaS scaffold shipping to main",
      cosine: 0.9,
    });
    const { deps } = makeDeps([cand], async () => "supersede");

    const d = await classifyConflict(
      TENANT,
      incoming({ title: "Helpshelf v1 SaaS application shipped", trust_tier: 2 }),
      deps,
    );

    expect(d.relation).toBe("supersede");
    expect(d.supersedeTargetIds).toEqual(["scaffold"]);
    expect(d.supersedeBlockedByDate).toBeUndefined();
  });
});

describe("classifyConflict — noop", () => {
  it("redundant restatement → relation 'noop', targetNoteId = existing", async () => {
    const cand = candidate({ note_id: "same-fact" });
    const { deps } = makeDeps([cand], async () => "noop");

    const d = await classifyConflict(TENANT, incoming(), deps);

    expect(d.relation).toBe("noop");
    expect(d.targetNoteId).toBe("same-fact");
  });

  it("noop wins over supersede + folds stale targets into the existing winner (no 3rd dup)", async () => {
    const winner = candidate({ note_id: "winner", body: "Upcar in 7 states.", cosine: 0.95, trust_tier: 2 });
    const stale = candidate({ note_id: "stale", body: "Upcar in 5 states.", cosine: 0.9, trust_tier: 2 });
    const classifyImpl = async (_i: IncomingFact, c: ConflictCandidate): Promise<ConflictRelation> =>
      c.note_id === "winner" ? "noop" : "supersede";
    const { deps } = makeDeps([winner, stale], classifyImpl);

    const d = await classifyConflict(TENANT, incoming({ trust_tier: 2 }), deps);

    expect(d.relation).toBe("noop");
    expect(d.targetNoteId).toBe("winner");
    expect(d.supersedeTargetIds).toEqual(["stale"]);
  });
});

describe("classifyConflict — topK scans all eligible candidates", () => {
  it("1st neighbor 'new', 2nd neighbor 'supersede' → ends 'supersede' on the 2nd", async () => {
    const c1 = candidate({ note_id: "unrelated", body: "Office is in SF.", cosine: 0.9, trust_tier: 2 });
    const c2 = candidate({ note_id: "stale-count", body: "Upcar in 5 states.", cosine: 0.85, trust_tier: 2 });
    const classifyImpl = async (_i: IncomingFact, c: ConflictCandidate): Promise<ConflictRelation> =>
      c.note_id === "stale-count" ? "supersede" : "new";
    const { deps, classify } = makeDeps([c1, c2], classifyImpl);

    const d = await classifyConflict(TENANT, incoming({ trust_tier: 2 }), deps);

    expect(d.relation).toBe("supersede");
    expect(d.targetNoteId).toBe("stale-count");
    expect(d.supersedeTargetIds).toEqual(["stale-count"]);
    expect(classify.mock.calls.length).toBe(2);
  });
});

describe("classifyConflict — fail-open", () => {
  it("classify throws → relation 'new'", async () => {
    const { deps } = makeDeps([candidate()], async () => {
      throw new Error("LLM 500");
    });
    const d = await classifyConflict(TENANT, incoming(), deps);
    expect(d.relation).toBe("new");
    expect(d.targetNoteId).toBeNull();
  });

  it("findCandidates throws → relation 'new', no classify call", async () => {
    const findCandidates = vi.fn(async () => {
      throw new Error("embed outage");
    });
    const classify = vi.fn(async () => "supersede" as ConflictRelation);
    const d = await classifyConflict(TENANT, incoming(), { findCandidates, classify });
    expect(d.relation).toBe("new");
    expect(classify.mock.calls.length).toBe(0);
  });

  it("no candidate clears the cosine gate → 'new', no classify call", async () => {
    const lowCand = candidate({ cosine: 0.5 });
    const { deps, classify } = makeDeps([lowCand], async () => "supersede");
    const d = await classifyConflict(TENANT, incoming(), deps);
    expect(d.relation).toBe("new");
    expect(classify.mock.calls.length).toBe(0);
  });

  it("candidate at 0.65 clears the 0.60 gate → reaches classifier (was blocked at 0.80)", async () => {
    const cand = candidate({ note_id: "stale-65", cosine: 0.65, trust_tier: 2 });
    const { deps, classify } = makeDeps([cand], async () => "supersede");
    const d = await classifyConflict(TENANT, incoming({ trust_tier: 2 }), deps);
    expect(classify.mock.calls.length).toBe(1);
    expect(d.relation).toBe("supersede");
    expect(d.targetNoteId).toBe("stale-65");
  });

  it("candidate at 0.55 stays below the 0.60 gate → 'new', no classify call", async () => {
    const { deps, classify } = makeDeps([candidate({ cosine: 0.55 })], async () => "supersede");
    const d = await classifyConflict(TENANT, incoming(), deps);
    expect(d.relation).toBe("new");
    expect(classify.mock.calls.length).toBe(0);
  });

  it("empty body → 'new', no candidate lookup", async () => {
    const { deps, findCandidates } = makeDeps([candidate()], async () => "supersede");
    const d = await classifyConflict(TENANT, incoming({ body: "   " }), deps);
    expect(d.relation).toBe("new");
    expect(findCandidates.mock.calls.length).toBe(0);
  });
});

function neighbor(over: Partial<Neighbor> = {}): Neighbor {
  return {
    note_id: "stale-1",
    title: "Upcar coverage",
    body_markdown: "Upcar operates in 5 states.",
    note_type: "untyped",
    cosine: 0.93,
    created_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function makeServiceClientMock() {
  function makeBuilder(table: string) {
    const st: { op: "insert" | "update" | null; selectCols: string } = { op: null, selectCols: "" };
    const b: Record<string, unknown> = {};
    b.select = vi.fn((cols?: string) => {
      st.selectCols = cols ?? "";
      return b;
    });
    for (const m of ["eq", "is", "order", "limit", "in"]) b[m] = vi.fn(() => b);
    b.insert = vi.fn(() => {
      st.op = "insert";
      return b;
    });
    b.update = vi.fn((arg: Record<string, unknown>) => {
      st.op = "update";
      H.updateCalls.push({ table, arg });
      return b;
    });
    b.upsert = vi.fn(async () => ({ data: null, error: null }));
    b.delete = vi.fn(() => b);
    b.maybeSingle = vi.fn(async () => {
      if (table === "memory_note" && /tags/.test(st.selectCols) && !/body_markdown/.test(st.selectCols)) {
        return { data: H.winnerRow, error: null };
      }
      return { data: null, error: null };
    });
    b.single = vi.fn(async () =>
      st.op === "insert" ? { data: { id: "new-note-1" }, error: null } : { data: null, error: null },
    );
    (b as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
      if (st.op === "update") {
        return resolve({ data: H.updateResult.data, error: H.updateResult.error });
      }
      if (table === "memory_note" && /trust_tier/.test(st.selectCols)) {
        return resolve({ data: H.tierErr ? null : H.tierRows, error: H.tierErr });
      }
      return resolve({ data: [], error: null });
    };
    return b;
  }

  return {
    from: vi.fn((t: string) => makeBuilder(t)),
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      H.rpcCalls.push({ name, args });
      if (name === "memory_nearest_neighbors") {
        const lim = (args.p_limit as number) ?? H.neighbors.length;
        return { data: H.neighbors.slice(0, lim), error: null };
      }
      return { data: null, error: null };
    }),
  };
}

function resetWiring() {
  H.rpcCalls.length = 0;
  H.updateCalls.length = 0;
  H.neighbors = [];
  H.tierRows = [];
  H.tierErr = null;
  H.winnerRow = null;
  H.updateResult = { data: [{ id: "winner" }], error: null };
  H.classifyFn = () => "supersede";
  H.sb.current = makeServiceClientMock();
}

function winner(over: Partial<NonNullable<typeof H.winnerRow>> = {}): NonNullable<typeof H.winnerRow> {
  return {
    tags: [],
    metadata: {},
    connector_object_keys: [],
    trust_tier: 2,
    source_ref: null,
    thread_id: null,
    agent_slug: null,
    ...over,
  };
}

const verdicts = () => H.rpcCalls.filter((c) => c.name === "apply_dream_verdict");

describe("writeNote wiring — conflict resolution", () => {
  beforeEach(resetWiring);

  it("supersede: inserts the new note then supersedes EACH stale target via KEEP_NEW", async () => {
    H.neighbors = [
      neighbor({ note_id: "stale-1", cosine: 0.93 }),
      neighbor({ note_id: "stale-2", body_markdown: "Upcar in 4 states.", cosine: 0.9 }),
    ];
    H.tierRows = [
      { id: "stale-1", trust_tier: 2 },
      { id: "stale-2", trust_tier: 2 },
    ];
    H.classifyFn = () => "supersede";

    const { writeNote } = await import("../index");
    const res = await writeNote(TENANT, {
      title: "Upcar coverage",
      body_markdown: "Upcar operates in 7 states.",
      note_type: "untyped",
      trust_tier: 2,
    });

    expect(res.note_id).toBe("new-note-1");
    expect(res.created).toBe(true);
    const v = verdicts();
    expect(v.length).toBe(2);
    for (const x of v) {
      expect(x.args.p_verdict).toBe("KEEP_NEW");
      expect(x.args.p_new_id).toBe("new-note-1");
      expect(x.args.p_tenant_id).toBe(TENANT);
    }
    expect(v.map((x) => x.args.p_existing_id).sort()).toEqual(["stale-1", "stale-2"]);
    const { MODELS } = await import("@/services/llm/models");
    expect(H.lastClassifyModel).toBe(MODELS.anthropic.haiku);
  });

  it("chunk-level dedup: 3 chunk hits of the SAME note → exactly ONE supersede call (P2 #5)", async () => {
    H.neighbors = [
      neighbor({ note_id: "stale-1", cosine: 0.95 }),
      neighbor({ note_id: "stale-1", cosine: 0.9 }),
      neighbor({ note_id: "stale-1", cosine: 0.85 }),
    ];
    H.tierRows = [{ id: "stale-1", trust_tier: 2 }];
    H.classifyFn = () => "supersede";

    const { writeNote } = await import("../index");
    await writeNote(TENANT, { body_markdown: "Upcar operates in 7 states.", note_type: "untyped" });

    const v = verdicts();
    expect(v.length).toBe(1);
    expect(v[0].args.p_existing_id).toBe("stale-1");
  });

  it("hydration error: trust-tier select fails → ALL candidates dropped, no supersede, note inserted (P1 #1)", async () => {
    H.neighbors = [neighbor({ note_id: "stale-1" })];
    H.tierErr = { message: "db down" };
    H.classifyFn = () => "supersede";

    const { writeNote } = await import("../index");
    const res = await writeNote(TENANT, { body_markdown: "Upcar operates in 7 states.", note_type: "untyped" });

    expect(res.note_id).toBe("new-note-1");
    expect(verdicts().length).toBe(0);
  });

  it("foreign-tenant candidate rejected: neighbor not returned by tenant-scoped select is dropped (P1 #1)", async () => {
    H.neighbors = [neighbor({ note_id: "stale-1" }), neighbor({ note_id: "foreign-1", cosine: 0.91 })];
    H.tierRows = [{ id: "stale-1", trust_tier: 2 }];
    H.classifyFn = () => "supersede";

    const { writeNote } = await import("../index");
    await writeNote(TENANT, { body_markdown: "Upcar operates in 7 states.", note_type: "untyped", trust_tier: 2 });

    const v = verdicts();
    expect(v.length).toBe(1);
    expect(v[0].args.p_existing_id).toBe("stale-1");
  });

  it("noop: existing winner wins (skip insert) + merges tags ∪ + metadata shallow-merge (P1 #3 / P2 #4)", async () => {
    H.neighbors = [neighbor({ note_id: "winner-1", body_markdown: "Upcar in 7 states." })];
    H.tierRows = [{ id: "winner-1", trust_tier: 2 }];
    H.winnerRow = winner({ tags: ["existing"], metadata: { keep: 1 } });
    H.classifyFn = () => "noop";

    const { writeNote } = await import("../index");
    const res = await writeNote(TENANT, {
      title: "Upcar coverage",
      body_markdown: "Upcar operates in 7 states.",
      note_type: "untyped",
      tags: ["new"],
      metadata: { added: 2 },
    });

    expect(res.note_id).toBe("winner-1");
    expect(res.created).toBeUndefined();
    expect(verdicts().length).toBe(0);

    const merge = H.updateCalls.find((u) => u.table === "memory_note");
    expect(merge).toBeTruthy();
    expect((merge!.arg.tags as string[]).sort()).toEqual(["existing", "new"]);
    expect(merge!.arg.metadata).toEqual({ keep: 1, added: 2 });
  });

  it("noop folds trust_tier to the HIGHER trust + fills source_ref (P1 #1 trust + source linkage)", async () => {
    H.neighbors = [neighbor({ note_id: "winner-1", body_markdown: "Upcar in 7 states." })];
    H.tierRows = [{ id: "winner-1", trust_tier: 2 }];
    H.winnerRow = winner({ trust_tier: 2, source_ref: null });
    H.classifyFn = () => "noop";

    const { writeNote } = await import("../index");
    await writeNote(TENANT, {
      body_markdown: "Upcar operates in 7 states.",
      note_type: "untyped",
      trust_tier: 0,
      source_ref: "slack:C1/ts1",
    });

    const merge = H.updateCalls.find((u) => u.table === "memory_note");
    expect(merge).toBeTruthy();
    expect(merge!.arg.trust_tier).toBe(0);
    expect(merge!.arg.source_ref).toBe("slack:C1/ts1");
  });

  it("noop FALLS BACK to a normal insert when the winner was superseded mid-flight (P2 #2 — no lost write)", async () => {
    H.neighbors = [neighbor({ note_id: "winner-1", body_markdown: "Upcar in 7 states." })];
    H.tierRows = [{ id: "winner-1", trust_tier: 2 }];
    H.winnerRow = winner();
    H.updateResult = { data: [], error: null };
    H.classifyFn = () => "noop";

    const { writeNote } = await import("../index");
    const res = await writeNote(TENANT, { body_markdown: "Upcar operates in 7 states.", note_type: "untyped" });

    expect(res.note_id).toBe("new-note-1");
    expect(res.created).toBe(true);
    expect(verdicts().length).toBe(0);
  });

  it("noop folds supersede: winner merges provenance AND stale target supersedes TO the winner id (P2 #4)", async () => {
    H.neighbors = [
      neighbor({ note_id: "winner-1", body_markdown: "WINNER_BODY", cosine: 0.96 }),
      neighbor({ note_id: "stale-9", body_markdown: "STALE_BODY", cosine: 0.9 }),
    ];
    H.tierRows = [
      { id: "winner-1", trust_tier: 2 },
      { id: "stale-9", trust_tier: 2 },
    ];
    H.winnerRow = winner();
    H.classifyFn = (msg) => (msg.includes("STALE_BODY") ? "supersede" : msg.includes("WINNER_BODY") ? "noop" : "new");

    const { writeNote } = await import("../index");
    const res = await writeNote(TENANT, { body_markdown: "Upcar operates in 7 states.", note_type: "untyped", trust_tier: 2 });

    expect(res.note_id).toBe("winner-1");
    const v = verdicts();
    expect(v.length).toBe(1);
    expect(v[0].args.p_verdict).toBe("KEEP_NEW");
    expect(v[0].args.p_new_id).toBe("winner-1");
    expect(v[0].args.p_existing_id).toBe("stale-9");
  });

  it("distinct-note recall: a multi-chunk nearest note does NOT crowd out a 2nd distinct note (P2 #5)", async () => {
    const bigChunks = Array.from({ length: 10 }, (_, i) =>
      neighbor({ note_id: "big", body_markdown: `big chunk ${i}`, cosine: 0.95 - i * 0.001 }),
    );
    H.neighbors = [...bigChunks, neighbor({ note_id: "other", body_markdown: "other note", cosine: 0.9 })];
    H.tierRows = [
      { id: "big", trust_tier: 2 },
      { id: "other", trust_tier: 2 },
    ];
    H.classifyFn = () => "supersede";

    const { writeNote } = await import("../index");
    await writeNote(TENANT, { body_markdown: "Upcar operates in 7 states.", note_type: "untyped", trust_tier: 2 });

    const ids = verdicts().map((v) => v.args.p_existing_id).sort();
    expect(ids).toEqual(["big", "other"]);
  });

  it("distinct-note recall ADAPTIVE: a 24+-chunk nearest note still doesn't hide a 2nd distinct note (P2 #5)", async () => {
    const bigChunks = Array.from({ length: 28 }, (_, i) =>
      neighbor({ note_id: "big", body_markdown: `big chunk ${i}`, cosine: 0.95 - i * 0.0005 }),
    );
    H.neighbors = [...bigChunks, neighbor({ note_id: "other", body_markdown: "other note", cosine: 0.9 })];
    H.tierRows = [
      { id: "big", trust_tier: 2 },
      { id: "other", trust_tier: 2 },
    ];
    H.classifyFn = () => "supersede";

    const { writeNote } = await import("../index");
    await writeNote(TENANT, { body_markdown: "Upcar operates in 7 states.", note_type: "untyped", trust_tier: 2 });

    const ids = verdicts().map((v) => v.args.p_existing_id).sort();
    expect(ids).toEqual(["big", "other"]);
  });

  it("noop FALLBACK still supersedes its folded stale targets (regression: fallback-insert must not skip supersede)", async () => {
    H.neighbors = [
      neighbor({ note_id: "winner-1", body_markdown: "WINNER_BODY", cosine: 0.96 }),
      neighbor({ note_id: "stale-9", body_markdown: "STALE_BODY", cosine: 0.9 }),
    ];
    H.tierRows = [
      { id: "winner-1", trust_tier: 2 },
      { id: "stale-9", trust_tier: 2 },
    ];
    H.winnerRow = winner();
    H.updateResult = { data: [], error: null };
    H.classifyFn = (msg) => (msg.includes("STALE_BODY") ? "supersede" : msg.includes("WINNER_BODY") ? "noop" : "new");

    const { writeNote } = await import("../index");
    const res = await writeNote(TENANT, { body_markdown: "Upcar operates in 7 states.", note_type: "untyped", trust_tier: 2 });

    expect(res.note_id).toBe("new-note-1");
    const v = verdicts();
    expect(v.length).toBe(1);
    expect(v[0].args.p_verdict).toBe("KEEP_NEW");
    expect(v[0].args.p_new_id).toBe("new-note-1");
    expect(v[0].args.p_existing_id).toBe("stale-9");
  });
});

describe("parseConflictRelation — robust to fenced + prose model output", () => {
  it("clean JSON → relation", () => {
    expect(parseConflictRelation('{"relation":"supersede"}')).toBe("supersede");
  });
  it("```json fenced → relation", () => {
    expect(parseConflictRelation('```json\n{"relation":"noop"}\n```')).toBe("noop");
  });
  it("Haiku-style fenced JSON + trailing prose → relation (was the gap#1 bug)", () => {
    const haiku = '```json\n{"relation":"supersede"}\n```\n\nThe NEW fact directly contradicts the EXISTING fact about the HQ location.';
    expect(parseConflictRelation(haiku)).toBe("supersede");
  });
  it("prose with no relation field → fail-open 'new'", () => {
    expect(parseConflictRelation("I think these two facts are unrelated, so nothing to do.")).toBe("new");
  });
  it("empty / garbage → 'new'", () => {
    expect(parseConflictRelation("")).toBe("new");
    expect(parseConflictRelation("{}")).toBe("new");
  });
  it("unknown relation value → 'new'", () => {
    expect(parseConflictRelation('{"relation":"merge"}')).toBe("new");
  });
});

describe("isDatedSnapshotConflict — the pure title guard", () => {
  it.each([
    ["Funnel diagnosis — 2026-06-03", "Funnel diagnosis — 2026-07-04"],
    ["Growth attribution snapshot — 2026-06-05", "Growth attribution snapshot — 2026-07-04"],
    ["Ads channel perf — 2026-06-12", "Ads channel perf — 2026-07-05"],
    ["Weekly report – 2026-06-01", "Weekly report – 2026-07-01"],
  ])("BLOCK: same em/en-dash slot, different date: %s vs %s", (a, b) => {
    expect(isDatedSnapshotConflict(a, b)).toBe(true);
    expect(isDatedSnapshotConflict(b, a)).toBe(true);
  });

  it.each([
    ["Funnel diagnosis — 2026-07-04", "Funnel diagnosis — 2026-07-04"],
    ["Voltway database schema", "Session management: HMAC-based, expiring, fail-closed"],
    ["Helpshelf v1 SaaS scaffold shipping to main", "Helpshelf v1 SaaS application shipped"],
    ["Launch deadline is 2026-07-15", "Launch deadline is 2026-08-01"],
    ["Launch deadline: 2026-07-15", "Launch deadline: 2026-08-01"],
    ["Sprint 12 - 2026-07-15", "Sprint 12 - 2026-08-01"],
    ["Funnel diagnosis — 2026-06-03", "Funnel diagnosis latest"],
    ["Product roadmap", "Marketplace instrumentation roadmap"],
  ])("PASS-THROUGH (not blocked): %s vs %s", (a, b) => {
    expect(isDatedSnapshotConflict(a, b)).toBe(false);
  });
});
