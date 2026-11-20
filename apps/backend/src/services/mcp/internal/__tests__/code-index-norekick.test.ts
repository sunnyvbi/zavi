
import { describe, it, expect, vi, beforeEach } from "vitest";

const { indexRepoMock, canIndexMock, embedOneMock, resolveRepoMock, stateRowState, queryRowsState } =
  vi.hoisted(() => ({
    indexRepoMock: vi.fn(),
    canIndexMock: vi.fn(),
    embedOneMock: vi.fn(),
    resolveRepoMock: vi.fn(),
    stateRowState: { value: undefined as unknown, error: null as unknown },
    queryRowsState: { value: [] as unknown[], error: null as unknown },
  }));

vi.mock("@/services/code-index/build", () => ({
  indexRepo: indexRepoMock,
  isCodeSymbolIndexEnabled: () => true,
}));
vi.mock("@/services/code-index/cost-cap", () => ({
  canIndex: canIndexMock,
}));
vi.mock("@/services/memory/embed", () => ({
  embedOne: embedOneMock,
}));
vi.mock("@/services/agents/repo-resolver", () => ({
  resolveRepoFullName: resolveRepoMock,
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    rpc: vi.fn(async () => ({ data: queryRowsState.value, error: queryRowsState.error })),
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: stateRowState.value, error: stateRowState.error }),
          }),
        }),
      }),
    }),
  }),
}));

import { callCodeIndexTool } from "../code-index";
import type { CallMcpContext } from "../../execute";

const ctx: CallMcpContext = { tenant_id: "tenant-1", run_id: "run-1", repo_full_name: "owner/name" };

function parseContent(content: string): { status?: string; message?: string } {
  return JSON.parse(content) as { status?: string; message?: string };
}

beforeEach(() => {
  indexRepoMock.mockReset();
  canIndexMock.mockReset();
  embedOneMock.mockReset();
  resolveRepoMock.mockReset();
  resolveRepoMock.mockResolvedValue("owner/name");
  embedOneMock.mockResolvedValue([0.1, 0.2, 0.3]);
  canIndexMock.mockResolvedValue({ ok: true });
  indexRepoMock.mockResolvedValue({ status: "indexed", indexed: 1, refs: 0, skipped: 0 });
  queryRowsState.value = [];
  queryRowsState.error = null;
  stateRowState.value = undefined;
  stateRowState.error = null;
});

describe("callCodeIndexTool — no-rekick guard on 0 rows", () => {
  it("committed generation EXISTS → genuine not-found, NO rebuild kicked", async () => {
    stateRowState.value = { current_build_id: "11111111-1111-1111-1111-111111111111" };
    const res = await callCodeIndexTool(ctx, "code_def", { symbol_name: "ghostSymbol" });
    expect(res.is_error).toBe(false);
    const body = parseContent(res.content);
    expect(body.status).toBe("unavailable");
    expect(body.message).toContain("not found in the indexed generation");
    expect(indexRepoMock).not.toHaveBeenCalled();
  });

  it("COLD — no state row → kicks a background build (retry-shortly degrade)", async () => {
    stateRowState.value = undefined;
    const res = await callCodeIndexTool(ctx, "code_def", { symbol_name: "newSymbol" });
    expect(res.is_error).toBe(false);
    const body = parseContent(res.content);
    expect(body.message).toContain("index build was started in the background");
    expect(indexRepoMock).toHaveBeenCalledTimes(1);
    expect(indexRepoMock).toHaveBeenCalledWith({ tenantId: "tenant-1", repo: "owner/name" });
  });

  it("COLD — state row with NULL current_build_id → kicks a background build", async () => {
    stateRowState.value = { current_build_id: null };
    const res = await callCodeIndexTool(ctx, "code_def", { symbol_name: "newSymbol" });
    const body = parseContent(res.content);
    expect(body.message).toContain("index build was started in the background");
    expect(indexRepoMock).toHaveBeenCalledTimes(1);
  });

  it("state lookup ERROR → falls back to OLD behavior (kicks) so a blip can't suppress indexing", async () => {
    stateRowState.value = null;
    stateRowState.error = { message: "transient db blip" };
    const res = await callCodeIndexTool(ctx, "code_def", { symbol_name: "anySymbol" });
    const body = parseContent(res.content);
    expect(body.message).toContain("index build was started in the background");
    expect(indexRepoMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT consult code_index_state when rows ARE returned (happy path, no degrade)", async () => {
    queryRowsState.value = [
      { symbol_name: "realSymbol", kind: "function", file_path: "a.ts", start_line: 1, end_line: 2 },
    ];
    const res = await callCodeIndexTool(ctx, "code_def", { symbol_name: "realSymbol" });
    expect(res.is_error).toBe(false);
    const body = JSON.parse(res.content) as { results?: unknown[] };
    expect(body.results?.length).toBe(1);
    expect(indexRepoMock).not.toHaveBeenCalled();
  });
});
