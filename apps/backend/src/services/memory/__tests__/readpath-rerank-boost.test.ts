
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  rpcMock: vi.fn(),
  fromMock: vi.fn(),
  embedOneMock: vi.fn(),
  rerankDocumentsMock: vi.fn(),
  getNumberSettingMock: vi.fn(),
  getStringSettingMock: vi.fn(),
  getBoolSettingMock: vi.fn(),
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ rpc: h.rpcMock, from: h.fromMock }),
}));
vi.mock("../embed", () => ({
  EMBED_DIM: 1024,
  embedOne: h.embedOneMock,
  embedTexts: vi.fn(async () => []),
  VoyageDimError: class VoyageDimError extends Error {},
}));
vi.mock("../rerank", () => ({
  RERANK_POOL_K: 60,
  RERANK_MAX_DOC_CHARS: 4000,
  RERANK_MODEL_NAME: "rerank-2.5",
  RERANK_TIMEOUT_MS: 2500,
  RERANK_STAGE_MS: 3500,
  rerankDocuments: h.rerankDocumentsMock,
}));
vi.mock("@/services/settings", () => ({
  getNumberSetting: h.getNumberSettingMock,
  getStringSetting: h.getStringSettingMock,
  getBoolSetting: h.getBoolSettingMock,
}));

import { searchMemory } from "../index";

const TENANT = "11111111-1111-1111-1111-111111111111";

type Row = {
  note_id: string;
  trust_tier?: number | null;
  note_type?: string;
  rerank_score?: number;
};

let universe: Row[] = [];
let inScopeIds: Set<string> = new Set();
let v2Calls: Array<Record<string, unknown>> = [];
let tablesQueried: string[] = [];

function hitRow(note_id: string) {
  return {
    chunk_id: `chunk-${note_id}`,
    note_id,
    title: `title ${note_id}`,
    body: `body ${note_id}`,
    score: 0.123,
  };
}

function rpcResultFor(connectorKeys: unknown): { data: unknown; error: null } {
  const rows =
    connectorKeys == null ? universe : universe.filter((r) => inScopeIds.has(r.note_id));
  return { data: rows.map((r) => hitRow(r.note_id)), error: null };
}

function metaQuery() {
  const q: Record<string, unknown> = {};
  const metaRows = universe.map((r) => ({
    id: r.note_id,
    source: "test",
    note_type: r.note_type ?? "untyped",
    created_at: new Date().toISOString(),
    trust_tier: r.trust_tier ?? 2,
    agent_slug: null,
    thread_id: null,
  }));
  q.select = () => q;
  q.eq = () => q;
  q.in = () => q;
  (q as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
    resolve({ data: metaRows, error: null });
  return q;
}

beforeEach(() => {
  vi.clearAllMocks();
  v2Calls = [];
  tablesQueried = [];
  universe = [];
  inScopeIds = new Set();

  h.embedOneMock.mockResolvedValue(new Array(1024).fill(0.01));
  h.getNumberSettingMock.mockResolvedValue(0);
  h.getStringSettingMock.mockResolvedValue("none");
  h.getBoolSettingMock.mockResolvedValue(false);

  h.fromMock.mockImplementation((table: string) => {
    tablesQueried.push(table);
    return metaQuery();
  });

  h.rpcMock.mockImplementation((name: string, args: Record<string, unknown>) => {
    if (name === "memory_search_hybrid") {
      return Promise.resolve(rpcResultFor(args.p_connector_keys));
    }
    if (name === "memory_search_hybrid_v2") {
      v2Calls.push(args);
      return Promise.resolve(rpcResultFor(args.p_connector_keys));
    }
    return Promise.resolve({ data: [], error: null });
  });

  h.rerankDocumentsMock.mockImplementation((_q: string, docs: string[]) =>
    docs.map((_d, i) => ({ index: i, relevance_score: 1 - i * 0.1 })),
  );
});

describe("FIX #1 — rerank pool honors connector-object scope", () => {
  it("forwards the normalized connector keys to memory_search_hybrid_v2 and excludes out-of-scope notes", async () => {
    universe = [
      { note_id: "in" },
      { note_id: "out" },
    ];
    inScopeIds = new Set(["in"]);

    const hits = await searchMemory(TENANT, "what about cus_X", 3, {
      agent_slug: "support-lead",
      connector_keys: ["stripe_customer:cus_X"],
      benchOverride: { reranker: true },
    });

    expect(v2Calls.length).toBeGreaterThan(0);
    expect(v2Calls[0].p_connector_keys).toEqual(["stripe_customer:cus_X"]);

    const ids = hits.map((x) => x.note_id);
    expect(ids).toContain("in");
    expect(ids).not.toContain("out");
  });

  it("passes p_connector_keys = null (full corpus) when the caller supplies no keys ([]→null, never 'match nothing')", async () => {
    universe = [{ note_id: "in" }, { note_id: "out" }];
    inScopeIds = new Set(["in"]);

    const hits = await searchMemory(TENANT, "general question", 3, {
      agent_slug: "support-lead",
      connector_keys: [],
      benchOverride: { reranker: true },
    });

    expect(v2Calls.length).toBeGreaterThan(0);
    expect(v2Calls[0].p_connector_keys).toBeNull();

    const ids = hits.map((x) => x.note_id);
    expect(ids).toEqual(expect.arrayContaining(["in", "out"]));
  });

  it("passes p_connector_keys = null when connector_keys is omitted entirely", async () => {
    universe = [{ note_id: "in" }, { note_id: "out" }];
    inScopeIds = new Set(["in"]);

    await searchMemory(TENANT, "q", 3, {
      agent_slug: "support-lead",
      benchOverride: { reranker: true },
    });

    expect(v2Calls[0].p_connector_keys).toBeNull();
  });
});

describe("FIX #2 — retired boosts no longer affect ordering; precedence + floor kept", () => {
  it("does NOT read the boost source tables (takes / memory_note_entity / memory_relation) during a search", async () => {
    universe = [{ note_id: "a" }, { note_id: "b" }];
    inScopeIds = new Set(["a", "b"]);

    await searchMemory(TENANT, "anything", 3, {
      agent_slug: "pm",
      benchOverride: { reranker: true },
    });

    expect(tablesQueried).not.toContain("takes");
    expect(tablesQueried).not.toContain("memory_note_entity");
    expect(tablesQueried).not.toContain("memory_relation");
    expect(new Set(tablesQueried)).toEqual(new Set(["memory_note", "memory_conflict_pair"]));
  });

  it("KEEPS trust-tier precedence: a tier-0 company fact outranks a higher-rerank-score tier-2 episodic", async () => {
    universe = [
      { note_id: "epi", trust_tier: 2, note_type: "agent_experience" },
      { note_id: "co", trust_tier: 0, note_type: "operator_preference" },
    ];
    inScopeIds = new Set(["epi", "co"]);
    h.rerankDocumentsMock.mockImplementation(() => [
      { index: 0, relevance_score: 0.95 },
      { index: 1, relevance_score: 0.20 },
    ]);

    const hits = await searchMemory(TENANT, "q", 3, {
      agent_slug: "support-lead",
      benchOverride: { reranker: true },
    });

    expect(hits[0].note_id).toBe("co");
    expect(hits.map((x) => x.note_id)).toEqual(["co", "epi"]);
  });

  it("KEEPS the relevance floor: drops a low-score non-exempt hit but exempts an operator-asserted tier-0 fact", async () => {
    h.getNumberSettingMock.mockResolvedValue(0.3);
    universe = [
      { note_id: "keep", trust_tier: 2, note_type: "untyped" },
      { note_id: "drop", trust_tier: 2, note_type: "untyped" },
      { note_id: "co", trust_tier: 0, note_type: "operator_preference" },
    ];
    inScopeIds = new Set(["keep", "drop", "co"]);
    h.rerankDocumentsMock.mockImplementation(() => [
      { index: 0, relevance_score: 0.5 },
      { index: 1, relevance_score: 0.1 },
      { index: 2, relevance_score: 0.05 },
    ]);

    const hits = await searchMemory(TENANT, "q", 5, {
      agent_slug: "support-lead",
      benchOverride: { reranker: true },
    });

    const ids = hits.map((x) => x.note_id);
    expect(ids).toContain("keep");
    expect(ids).toContain("co");
    expect(ids).not.toContain("drop");
  });
});
