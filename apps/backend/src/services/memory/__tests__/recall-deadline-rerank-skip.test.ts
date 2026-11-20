
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  rpcMock: vi.fn(),
  fromMock: vi.fn(),
  embedOneMock: vi.fn(),
  rerankDocumentsMock: vi.fn(),
  getNumberSettingMock: vi.fn(),
  getStringSettingMock: vi.fn(),
  getBoolSettingMock: vi.fn(),
  runLexicalFallbackMock: vi.fn(),
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
vi.mock("../degraded-ladder", async (orig) => ({
  ...(await orig<typeof import("../degraded-ladder")>()),
  runLexicalFallback: h.runLexicalFallbackMock,
}));

import { searchMemory } from "../index";
import { RERANK_TIMEOUT_MS } from "../rerank";

const TENANT = "11111111-1111-1111-1111-111111111111";

function hitRow(note_id: string) {
  return {
    chunk_id: `chunk-${note_id}`,
    note_id,
    title: `title ${note_id}`,
    body: `body ${note_id}`,
    score: 0.123,
  };
}

function metaQuery() {
  const q: Record<string, unknown> = {};
  q.select = () => q;
  q.eq = () => q;
  q.in = () => q;
  q.insert = () => ({ then: (r: (v: unknown) => unknown) => r({ error: null }) });
  (q as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
    resolve({
      data: [
        {
          id: "n1",
          source: "test",
          note_type: "untyped",
          created_at: new Date().toISOString(),
          trust_tier: 2,
          agent_slug: null,
          thread_id: null,
        },
      ],
      error: null,
    });
  return q;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.embedOneMock.mockResolvedValue(new Array(1024).fill(0.01));
  h.getNumberSettingMock.mockResolvedValue(0);
  h.getStringSettingMock.mockResolvedValue("none");
  h.getBoolSettingMock.mockResolvedValue(false);
  h.fromMock.mockImplementation(() => metaQuery());
  h.rpcMock.mockImplementation(() => Promise.resolve({ data: [hitRow("n1")], error: null }));
  h.rerankDocumentsMock.mockImplementation((_q: string, docs: string[]) =>
    docs.map((_d, i) => ({ index: i, relevance_score: 1 - i * 0.1 })),
  );
  h.runLexicalFallbackMock.mockResolvedValue({ hits: [], mode: "lex_or", candidates: 0 });
});

describe("searchMemory — the rerank yields to the caller's deadline", () => {
  it("skips the rerank and STILL returns hits when the rerank allowance no longer fits", async () => {
    const hits = await searchMemory(TENANT, "what is our take rate", 3, {
      agent_slug: "operator",
      benchOverride: { reranker: true },
      deadline_at: Date.now() + RERANK_TIMEOUT_MS / 2,
    });

    expect(h.rerankDocumentsMock).not.toHaveBeenCalled();
    expect(hits.map((x) => x.note_id)).toContain("n1");
  });

  it("still reranks when the deadline leaves room", async () => {
    const hits = await searchMemory(TENANT, "what is our take rate", 3, {
      agent_slug: "operator",
      benchOverride: { reranker: true },
      deadline_at: Date.now() + RERANK_TIMEOUT_MS + 60_000,
    });

    expect(h.rerankDocumentsMock).toHaveBeenCalled();
    expect(hits.map((x) => x.note_id)).toContain("n1");
  });

  it("skips when the Voyage allowance fits but the whole STAGE does not", async () => {
    const hits = await searchMemory(TENANT, "what is our take rate", 3, {
      agent_slug: "operator",
      benchOverride: { reranker: true },
      deadline_at: Date.now() + RERANK_TIMEOUT_MS + 500,
    });

    expect(h.rerankDocumentsMock).not.toHaveBeenCalled();
    expect(hits.map((x) => x.note_id)).toContain("n1");
  });

  it("reranks unconditionally for callers with no deadline (eval/replay/canary, notes API)", async () => {
    await searchMemory(TENANT, "what is our take rate", 3, {
      agent_slug: "operator",
      benchOverride: { reranker: true },
    });

    expect(h.rerankDocumentsMock).toHaveBeenCalled();
  });
});

describe("searchMemory — an RPC failure falls back instead of giving up", () => {
  const rpcFails = () =>
    h.rpcMock.mockImplementation((name: string) =>
      name === "memory_search_hybrid"
        ? Promise.resolve({
            data: null,
            error: { message: "canceling statement due to statement timeout" },
          })
        : Promise.resolve({ data: [], error: null }),
    );

  it("serves the lexical rung's hits when the hybrid RPC errors", async () => {
    rpcFails();
    h.runLexicalFallbackMock.mockResolvedValue({
      hits: [
        { chunk_id: "c1", note_id: "n1", title: "t", body: "b", score: 0.4 },
      ],
      mode: "lex_or",
      candidates: 1,
    });

    const hits = await searchMemory(TENANT, "what is our take rate", 3, {
      agent_slug: "operator",
    });

    expect(h.runLexicalFallbackMock).toHaveBeenCalled();
    expect(hits.map((x) => x.note_id)).toEqual(["n1"]);
  });

  it("does not spend a second RPC on the rung when the caller's deadline cannot hold it", async () => {
    rpcFails();
    h.runLexicalFallbackMock.mockResolvedValue({
      hits: [{ chunk_id: "c1", note_id: "n1", title: "t", body: "b", score: 0.4 }],
      mode: "lex_or",
      candidates: 1,
    });

    await expect(
      searchMemory(TENANT, "what is our take rate", 3, {
        agent_slug: "operator",
        deadline_at: Date.now() + 50,
      }),
    ).rejects.toThrow(/memory_search_hybrid failed/);
    expect(h.runLexicalFallbackMock).not.toHaveBeenCalled();
  });

  it("still runs the rung for a caller whose deadline has room", async () => {
    rpcFails();
    h.runLexicalFallbackMock.mockResolvedValue({
      hits: [{ chunk_id: "c1", note_id: "n1", title: "t", body: "b", score: 0.4 }],
      mode: "lex_or",
      candidates: 1,
    });

    const hits = await searchMemory(TENANT, "what is our take rate", 3, {
      agent_slug: "operator",
      deadline_at: Date.now() + 60_000,
    });

    expect(h.runLexicalFallbackMock).toHaveBeenCalled();
    expect(hits.map((x) => x.note_id)).toEqual(["n1"]);
  });

  it("still throws when the rung is empty too — a broken DB must stay loud", async () => {
    rpcFails();
    h.runLexicalFallbackMock.mockResolvedValue({ hits: [], mode: "lex_or", candidates: 0 });

    await expect(
      searchMemory(TENANT, "what is our take rate", 3, { agent_slug: "operator" }),
    ).rejects.toThrow(/memory_search_hybrid failed/);
  });
});
