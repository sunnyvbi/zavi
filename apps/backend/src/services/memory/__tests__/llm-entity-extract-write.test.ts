
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  sb: { current: null as unknown },
  flags: {} as Record<string, { tenant?: boolean; global?: boolean }>,
  upserts: [] as Array<{ table: string; rows: unknown }>,
  rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  neighbors: [] as Array<Record<string, unknown>>,
  tierRows: [] as Array<{ id: string; trust_tier: number | null }>,
  winnerRow: null as Record<string, unknown> | null,
  updateResult: { data: [{ id: "winner" }] as Array<{ id: string }>, error: null as { message: string } | null },
  classifyFn: (_userMsg: string): string => "noop",
  liveDup: null as Record<string, unknown> | null,
  distillArtifacts: [] as Array<{ note_type: string; title: string; body_markdown: string; tags?: string[] }>,
  typedGraph: { entities: [] as Array<{ canonical: string; type: string }>, relations: [] as Array<{ from: string; to: string; type: string }> },
  extractThrows: false,
  extractEntitiesCalls: 0,
  extractGraphCalls: 0,
}));

vi.mock("../embed", () => ({
  EMBED_DIM: 1024,
  VoyageError: class VoyageError extends Error {},
  VoyageDimError: class VoyageDimError extends Error {},
  embedTexts: vi.fn(async (texts: string[]) => texts.map(() => new Array(1024).fill(0.01))),
  embedOne: vi.fn(async () => new Array(1024).fill(0.01)),
}));
vi.mock("../contextualize", () => ({
  contextualizeChunks: vi.fn((chunks: string[]) => chunks.map((c) => ({ body: c, contextualized: c }))),
}));
vi.mock("../extract", () => ({
  extractEntities: vi.fn(() => {
    H.extractEntitiesCalls += 1;
    return { entities: [{ entity_type: "email", canonical_name: "ops@upcar.ai", attrs: {} }] };
  }),
  extractEntitiesAndRelations: vi.fn(async () => {
    H.extractGraphCalls += 1;
    if (H.extractThrows) throw new Error("LLM extract 500");
    return H.typedGraph;
  }),
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => H.sb.current,
}));
vi.mock("@/services/anthropic", () => ({
  DEFAULT_MODEL: "opus-model",
  DEFAULT_FAST_MODEL: "fast-model",
  getAnthropic: vi.fn(() => ({
    messages: {
      create: vi.fn(async (req: { messages: Array<{ content: string }> }) => {
        const userMsg = req.messages?.[0]?.content ?? "";
        return { content: [{ type: "text", text: JSON.stringify({ relation: H.classifyFn(userMsg) }) }] };
      }),
    },
  })),
}));
vi.mock("@/services/llm/call-model", () => ({
  callModel: vi.fn(async () => ({
    text: JSON.stringify({ artifacts: H.distillArtifacts }),
    usage: { input_tokens: 0, output_tokens: 0 },
  })),
}));
vi.mock("@/services/logging/log-review", () => ({
  logReview: vi.fn(),
}));

const TENANT = "11111111-1111-1111-1111-111111111111";

function makeServiceClientMock() {
  function makeBuilder(table: string) {
    const st: { op: "insert" | "update" | null; selectCols: string; key: string; canonical: string } = {
      op: null,
      selectCols: "",
      key: "",
      canonical: "",
    };
    const b: Record<string, unknown> = {};
    b.select = vi.fn((cols?: string) => {
      st.selectCols = cols ?? "";
      return b;
    });
    b.eq = vi.fn((col: string, val: unknown) => {
      if (col === "key") st.key = String(val);
      if (col === "canonical_name") st.canonical = String(val);
      return b;
    });
    for (const m of ["is", "order", "limit", "in"]) b[m] = vi.fn(() => b);
    b.insert = vi.fn(() => {
      st.op = "insert";
      return b;
    });
    b.update = vi.fn(() => {
      st.op = "update";
      return b;
    });
    b.upsert = vi.fn(async (rows: unknown) => {
      H.upserts.push({ table, rows });
      return { data: null, error: null };
    });
    b.delete = vi.fn(() => b);
    b.maybeSingle = vi.fn(async () => {
      if (table === "tenant_app_setting") {
        const v = H.flags[st.key]?.tenant;
        return { data: v === undefined ? null : { value: v }, error: null };
      }
      if (table === "app_setting") {
        const v = H.flags[st.key]?.global;
        return { data: v === undefined ? null : { value: v }, error: null };
      }
      if (table === "memory_entity") {
        return { data: { id: `ent-${st.canonical}` }, error: null };
      }
      if (table === "memory_note") {
        if (st.op === "update") return { data: { id: "updated-note-1" }, error: null };
        if (/tags/.test(st.selectCols) && !/body_markdown/.test(st.selectCols)) {
          return { data: H.winnerRow, error: null };
        }
        if (/body_markdown/.test(st.selectCols)) {
          return { data: H.liveDup, error: null };
        }
        return { data: null, error: null };
      }
      return { data: null, error: null };
    });
    b.single = vi.fn(async () =>
      st.op === "insert" ? { data: { id: "new-note-1" }, error: null } : { data: null, error: null },
    );
    (b as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
      if (st.op === "update") return resolve({ data: H.updateResult.data, error: H.updateResult.error });
      if (table === "memory_note" && /trust_tier/.test(st.selectCols)) {
        return resolve({ data: H.tierRows, error: null });
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

function neighbor(over: Record<string, unknown> = {}) {
  return {
    note_id: "winner-1",
    title: "Acme deal",
    body_markdown: "Acme is in talks.",
    note_type: "untyped",
    cosine: 0.93,
    created_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

beforeEach(async () => {
  H.flags = {};
  H.upserts.length = 0;
  H.rpcCalls.length = 0;
  H.neighbors = [];
  H.tierRows = [];
  H.winnerRow = null;
  H.updateResult = { data: [{ id: "winner" }], error: null };
  H.classifyFn = () => "noop";
  H.typedGraph = {
    entities: [
      { canonical: "Acme", type: "company" },
      { canonical: "Jane", type: "person" },
    ],
    relations: [{ from: "Jane", to: "Acme", type: "works_at" }],
  };
  H.extractThrows = false;
  H.extractEntitiesCalls = 0;
  H.extractGraphCalls = 0;
  H.liveDup = null;
  H.distillArtifacts = [];
  H.sb.current = makeServiceClientMock();
  const { logReview } = await import("@/services/logging/log-review");
  vi.mocked(logReview).mockClear();
  const { _resetSettingsCache } = await import("@/services/settings");
  _resetSettingsCache();
});

const relUpserts = () => H.upserts.filter((u) => u.table === "memory_relation");
const entityUpserts = () => H.upserts.filter((u) => u.table === "memory_entity");

describe("writeNote — GAP #3 LLM typed entity extraction (flag gate)", () => {
  it("flag OFF (explicit tenant opt-out) → extractEntitiesAndRelations NOT called; regex path only; no typed-graph/relation upserts", async () => {
    H.flags.memory_llm_entity_extract_enabled = { tenant: false };
    const { writeNote } = await import("../index");
    const res = await writeNote(TENANT, {
      title: "Acme deal",
      body_markdown: "Jane at Acme. ops@upcar.ai",
      note_type: "untyped",
    });

    expect(res.note_id).toBe("new-note-1");
    expect(H.extractGraphCalls).toBe(0);
    expect(H.extractEntitiesCalls).toBe(1);
    expect(res.entities).toBe(1);
    expect(res.edges).toBe(0);
    expect(relUpserts().length).toBe(0);
    expect(entityUpserts().length).toBe(1);
  });

  it("flag ON → extractEntitiesAndRelations called once; persistTypedGraph upserts entities+relations; counts include them; regex still ran", async () => {
    H.flags.memory_llm_entity_extract_enabled = { tenant: true };

    const { writeNote } = await import("../index");
    const res = await writeNote(TENANT, {
      title: "Acme deal",
      body_markdown: "Jane works at Acme. ops@upcar.ai",
      note_type: "untyped",
    });

    expect(res.note_id).toBe("new-note-1");
    expect(H.extractGraphCalls).toBe(1);
    expect(H.extractEntitiesCalls).toBe(1);
    expect(res.entities).toBe(3);
    expect(res.edges).toBe(1);
    expect(entityUpserts().length).toBe(3);
    expect(relUpserts().length).toBe(1);
    expect(relUpserts()[0].rows).toHaveLength(1);
  });

  it("flag ON + extractor throws → note write still succeeds (best-effort); regex entities still persisted", async () => {
    H.flags.memory_llm_entity_extract_enabled = { tenant: true };
    H.extractThrows = true;

    const { writeNote } = await import("../index");
    const res = await writeNote(TENANT, {
      title: "Acme deal",
      body_markdown: "Jane works at Acme. ops@upcar.ai",
      note_type: "untyped",
    });

    expect(res.note_id).toBe("new-note-1");
    expect(H.extractGraphCalls).toBe(1);
    expect(H.extractEntitiesCalls).toBe(1);
    expect(res.entities).toBe(1);
    expect(res.edges).toBe(0);
    expect(relUpserts().length).toBe(0);
  });

  it("does NOT run on the gap-#1 noop path (existing note wins, no new insert → no LLM call)", async () => {
    H.flags.memory_llm_entity_extract_enabled = { tenant: true };
    H.flags.memory_conflict_resolution_enabled = { tenant: true };
    H.neighbors = [neighbor({ note_id: "winner-1" })];
    H.tierRows = [{ id: "winner-1", trust_tier: 2 }];
    H.winnerRow = {
      tags: [],
      metadata: {},
      connector_object_keys: [],
      trust_tier: 2,
      source_ref: null,
      thread_id: null,
      agent_slug: null,
    };
    H.classifyFn = () => "noop";

    const { writeNote } = await import("../index");
    const res = await writeNote(TENANT, {
      title: "Acme deal",
      body_markdown: "Jane works at Acme.",
      note_type: "untyped",
      trust_tier: 2,
    });

    expect(res.note_id).toBe("winner-1");
    expect(H.extractGraphCalls).toBe(0);
    expect(relUpserts().length).toBe(0);
  });

  it("input.id update with CHANGED body, flag ON → extracts (re-written content)", async () => {
    H.flags.memory_llm_entity_extract_enabled = { tenant: true };

    const { writeNote } = await import("../index");
    const res = await writeNote(TENANT, {
      id: "note-x",
      title: "Acme deal",
      body_markdown: "Jane now works at Acme. ops@upcar.ai",
      note_type: "untyped",
    });

    expect(res.note_id).toBe("updated-note-1");
    expect(H.extractGraphCalls).toBe(1);
    expect(res.entities).toBe(3);
    expect(res.edges).toBe(1);
    expect(relUpserts().length).toBe(1);
  });

  it("dedup-merge with UNCHANGED body, flag ON → does NOT extract (no wasted LLM call)", async () => {
    H.flags.memory_llm_entity_extract_enabled = { tenant: true };
    const sameBody = "Jane works at Acme. ops@upcar.ai";
    H.liveDup = {
      id: "dup-1",
      body_markdown: sameBody,
      tags: [],
      metadata: {},
      connector_object_keys: [],
    };

    const { writeNote } = await import("../index");
    const res = await writeNote(TENANT, {
      title: "Acme deal",
      body_markdown: sameBody,
      note_type: "untyped",
    });

    expect(res.note_id).toBe("dup-1");
    expect(H.extractGraphCalls).toBe(0);
    expect(relUpserts().length).toBe(0);
  });
});

describe("runDistill — GAP #3 double-call avoidance", () => {
  const distillInput = (over: Record<string, unknown> = {}) => ({
    tenant_id: TENANT,
    source: "auto_distill_agent_run" as const,
    source_ref: "run-1",
    systemPrompt: "sys",
    userPrompt: "usr",
    baseTags: [],
    ...over,
  });

  it("flag ON → extractor called EXACTLY ONCE per note (writeNote owns it; distill skips) — not twice", async () => {
    H.flags.memory_llm_entity_extract_enabled = { tenant: true };
    H.distillArtifacts = [
      { note_type: "tenant_reference", title: "Acme deal", body_markdown: "Jane works at Acme." },
    ];

    const { runDistill } = await import("../distill");
    const res = await runDistill(distillInput());

    expect(res.written).toBe(1);
    expect(H.extractGraphCalls).toBe(1);
    expect(relUpserts().length).toBe(1);
  });

  it("flag OFF → distill owns the pass (today's behavior): extractor called once", async () => {
    H.distillArtifacts = [
      { note_type: "tenant_reference", title: "Acme deal", body_markdown: "Jane works at Acme." },
    ];

    const { runDistill } = await import("../distill");
    const res = await runDistill(distillInput());

    expect(res.written).toBe(1);
    expect(H.extractGraphCalls).toBe(1);
    expect(relUpserts().length).toBe(1);
  });
});

describe("consent isolation — memory_llm_entity_extract_enabled is per-tenant only", () => {
  it("global row is ignored (in CONSENT_KEYS_PER_TENANT_ONLY); registry default ON applies, explicit opt-out wins", async () => {
    const { isLlmEntityExtractEnabledForTenant } = await import("../llm-entity-extract-flag");

    H.flags.memory_llm_entity_extract_enabled = { global: false };
    expect(await isLlmEntityExtractEnabledForTenant("t-consent")).toBe(true);

    const { _resetSettingsCache: _r } = await import("@/services/settings");
    _r();
    H.flags.memory_llm_entity_extract_enabled = { tenant: false, global: true };
    expect(await isLlmEntityExtractEnabledForTenant("t-consent")).toBe(false);

    const { _resetSettingsCache } = await import("@/services/settings");
    _resetSettingsCache();
    H.flags.memory_llm_entity_extract_enabled = { tenant: true };
    expect(await isLlmEntityExtractEnabledForTenant("t-consent")).toBe(true);
  });
});

describe("writeNote — SOAK review logging (fleet-wide, replaces QA-gated diagnostics)", () => {
  it("memory_extract: successful extraction → logReview(feature=memory_extract, outcome=ok) with entity/edge counts", async () => {
    H.flags.memory_llm_entity_extract_enabled = { tenant: true };
    H.typedGraph = {
      entities: [
        { canonical: "Acme", type: "company" },
        { canonical: "Jane", type: "person" },
      ],
      relations: [{ from: "Jane", to: "Acme", type: "works_at" }],
    };

    const { writeNote } = await import("../index");
    const { logReview } = await import("@/services/logging/log-review");
    await writeNote(TENANT, {
      title: "Acme deal",
      body_markdown: "Jane works at Acme. ops@upcar.ai",
      note_type: "untyped",
    });

    const calls = vi.mocked(logReview).mock.calls.map((c) => c[0]);
    const extractLog = calls.find((a) => a.feature === "memory_extract");
    expect(extractLog).toBeDefined();
    expect(extractLog).toMatchObject({
      feature: "memory_extract",
      event: "write",
      outcome: "ok",
      run_id: "new-note-1",
      tenant_id: TENANT,
    });
    expect(extractLog?.meta?.entities).toBe(2);
    expect(extractLog?.meta?.edges).toBe(1);
    expect(typeof extractLog?.meta?.ms).toBe("number");
    expect(calls.some((a) => a.feature === "memory_conflict")).toBe(false);
  });

  it("memory_extract: 0-entity success is NOT logged (volume bound)", async () => {
    H.flags.memory_llm_entity_extract_enabled = { tenant: true };
    H.typedGraph = { entities: [], relations: [] };

    const { writeNote } = await import("../index");
    const { logReview } = await import("@/services/logging/log-review");
    await writeNote(TENANT, {
      title: "No entities here",
      body_markdown: "just some prose with nothing to extract",
      note_type: "untyped",
    });

    const calls = vi.mocked(logReview).mock.calls.map((c) => c[0]);
    expect(calls.some((a) => a.feature === "memory_extract")).toBe(false);
  });

  it("memory_conflict: a supersede decision → logReview(feature=memory_conflict, outcome=supersede) with cosine + supersede_count", async () => {
    H.flags.memory_conflict_resolution_enabled = { tenant: true };
    H.flags.memory_llm_entity_extract_enabled = { tenant: false };
    H.neighbors = [neighbor({ note_id: "stale-1", cosine: 0.93 })];
    H.tierRows = [{ id: "stale-1", trust_tier: 2 }];
    H.classifyFn = () => "supersede";

    const { writeNote } = await import("../index");
    const { logReview } = await import("@/services/logging/log-review");
    const res = await writeNote(TENANT, {
      title: "Acme is now in 7 states",
      body_markdown: "Acme operates in 7 states as of today.",
      note_type: "untyped",
      trust_tier: 2,
    });

    expect(res.note_id).toBe("new-note-1");
    expect(H.rpcCalls.some((r) => r.name === "apply_dream_verdict")).toBe(true);

    const calls = vi.mocked(logReview).mock.calls.map((c) => c[0]);
    const conflictLog = calls.find((a) => a.feature === "memory_conflict");
    expect(conflictLog).toBeDefined();
    expect(conflictLog).toMatchObject({
      feature: "memory_conflict",
      event: "resolve",
      outcome: "supersede",
      run_id: "new-note-1",
      tenant_id: TENANT,
    });
    expect(conflictLog?.meta?.supersede_count).toBe(1);
    expect(conflictLog?.meta?.blocked_by_trust).toBe(0);
    expect(conflictLog?.meta?.cosine).toBeCloseTo(0.93, 3);
    expect(typeof conflictLog?.meta?.ms).toBe("number");
  });

  it("memory_conflict: a plain 'new' (no candidate) is NOT logged (volume bound)", async () => {
    H.flags.memory_conflict_resolution_enabled = { tenant: true };
    H.flags.memory_llm_entity_extract_enabled = { tenant: false };
    H.neighbors = [];

    const { writeNote } = await import("../index");
    const { logReview } = await import("@/services/logging/log-review");
    await writeNote(TENANT, {
      title: "Brand new fact",
      body_markdown: "Something entirely unrelated to anything stored.",
      note_type: "untyped",
      trust_tier: 2,
    });

    const calls = vi.mocked(logReview).mock.calls.map((c) => c[0]);
    expect(calls.some((a) => a.feature === "memory_conflict")).toBe(false);
  });
});

describe("runDistill — Founder Rules: distillers no longer write notes that steer agents", () => {
  it.each(["auto_distill_chat", "auto_distill_agent_run"] as const)(
    "%s: operator_preference and agent_procedural are dropped, a fact still writes",
    async (source) => {
      H.distillArtifacts = [
        { note_type: "operator_preference", title: "No weekend posts", body_markdown: "Never post on weekends." },
        { note_type: "agent_procedural", title: "Always PR", body_markdown: "Always open a draft PR." },
        { note_type: "tenant_reference", title: "Acme deal", body_markdown: "Jane works at Acme." },
      ];
      const { runDistill } = await import("../distill");
      const res = await runDistill({
        tenant_id: TENANT,
        source,
        source_ref: "run-1",
        systemPrompt: "sys",
        userPrompt: "usr",
        baseTags: [],
        agent_slug: "operator",
      } as Parameters<typeof runDistill>[0]);
      expect(res.written).toBe(1);
      expect(res.skipped).toBeGreaterThanOrEqual(2);
    },
  );
});
