
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { fromMock, lastQuery } = vi.hoisted(() => {
  const lastQuery: {
    table?: string;
    selectCols?: string;
    selectOpts?: unknown;
    filters: Array<{ op: string; col: string; val: unknown }>;
  } = { filters: [] };

  const state: { result: { count: number | null; error: { message: string } | null } } = {
    result: { count: 0, error: null },
  };

  function makeBuilder() {
    const builder: Record<string, unknown> = {};
    const chain = (op: string) => (col: string, val: unknown) => {
      lastQuery.filters.push({ op, col, val });
      return builder;
    };
    builder.select = (cols: string, opts?: unknown) => {
      lastQuery.selectCols = cols;
      lastQuery.selectOpts = opts;
      return builder;
    };
    builder.eq = chain("eq");
    builder.gte = chain("gte");
    builder.lt = chain("lt");
    builder.then = (resolve: (v: unknown) => unknown) => resolve(state.result);
    return builder;
  }

  const fromMock = vi.fn((table: string) => {
    lastQuery.table = table;
    lastQuery.filters = [];
    lastQuery.selectCols = undefined;
    lastQuery.selectOpts = undefined;
    return makeBuilder();
  });

  (fromMock as unknown as { __setResult: (r: typeof state.result) => void }).__setResult = (r) => {
    state.result = r;
  };

  return { fromMock, lastQuery };
});

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ from: fromMock }),
}));

import { canIndex } from "../cost-cap";

type QueryResult = { count: number | null; error: { message: string } | null };
const setResult = (r: QueryResult) =>
  (fromMock as unknown as { __setResult: (r: QueryResult) => void }).__setResult(r);

beforeEach(() => {
  fromMock.mockClear();
  delete process.env.PRAXIS_MAX_CODE_INDEX_PER_TENANT_PER_DAY;
  setResult({ count: 0, error: null });
});

afterEach(() => {
  delete process.env.PRAXIS_MAX_CODE_INDEX_PER_TENANT_PER_DAY;
});

describe("canIndex cost-cap accounting (P2 — prune-immune build log)", () => {
  it("counts from code_index_builds, NOT from code_symbols (the prune-broken source)", async () => {
    setResult({ count: 1, error: null });
    await canIndex("tenant-1");
    expect(lastQuery.table).toBe("code_index_builds");
    expect(lastQuery.table).not.toBe("code_symbols");
    expect(lastQuery.filters).toContainEqual({ op: "eq", col: "tenant_id", val: "tenant-1" });
    expect(lastQuery.filters.some((f) => f.op === "gte" && f.col === "built_at")).toBe(true);
    expect(lastQuery.filters.some((f) => f.op === "lt" && f.col === "built_at")).toBe(true);
    expect(lastQuery.selectOpts).toMatchObject({ count: "exact", head: true });
  });

  it("3 same-day builds ⇒ used=3 (survives the generation prune; old proxy would see 1)", async () => {
    setResult({ count: 3, error: null });
    const r = await canIndex("t");
    expect(r.used).toBe(3);
    expect(r.cap).toBe(5);
    expect(r.remaining).toBe(2);
    expect(r.ok).toBe(true);
    expect(r.reason).toBeUndefined();
  });

  it("at the cap ⇒ over_cap, remaining 0", async () => {
    setResult({ count: 5, error: null });
    const r = await canIndex("t");
    expect(r.ok).toBe(false);
    expect(r.used).toBe(5);
    expect(r.remaining).toBe(0);
    expect(r.reason).toBe("over_cap");
  });

  it("past the cap (6 builds, prune-immune) still blocks — the bug this fixes", async () => {
    setResult({ count: 6, error: null });
    const r = await canIndex("t");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("over_cap");
  });

  it("fails CLOSED with reason db_error on a counter-read failure (never over_cap)", async () => {
    setResult({ count: null, error: { message: "connection reset" } });
    const r = await canIndex("t");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("db_error");
    expect(r.remaining).toBe(0);
  });

  it("cap<=0 short-circuits to over_cap with NO DB read", async () => {
    process.env.PRAXIS_MAX_CODE_INDEX_PER_TENANT_PER_DAY = "0";
    const r = await canIndex("t");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("over_cap");
    expect(r.cap).toBe(0);
    expect(fromMock).not.toHaveBeenCalled();
  });
});
