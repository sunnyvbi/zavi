
import { beforeEach, describe, expect, it, vi } from "vitest";

const runCodeActReads = vi.fn(async () => [
  {
    index: 0,
    row_count: 2,
    row_count_exact: true,
    truncated: false,
    rows: [
      { n: 41, city: "Los Angeles" },
      { n: 17, city: "Austin" },
    ],
  },
]);

let computeResult: Record<string, unknown> = { ok: true, result: 58 };

vi.mock("@/services/data-gateway", () => ({
  withReadSession: async (_ctx: unknown, fn: (s: unknown) => unknown) => fn({ dialect: "postgres" }),
}));
vi.mock("@/services/tools/operator-db/codeact-sql", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  runCodeActReads: () => runCodeActReads(),
}));
vi.mock("@/services/analytics/tenant-timezone", () => ({
  resolveReportingTimezone: vi.fn(async () => ({ tz: "America/Chicago", source: "stored" })),
}));
vi.mock("@/services/sandbox/codeact-sandbox", () => ({
  runCodeActPython: async () => computeResult,
}));
vi.mock("@/services/analytics/verified-queries", () => ({ findSimilarVerifiedQueries: async () => [] }));
vi.mock("@/services/analytics/data-notes", () => ({ listActiveDataNotes: async () => [] }));

import { codeactTool } from "../codeact-tool";

const ctx = { tenant_id: "t1", log: vi.fn() };
const call = () =>
  codeactTool.execute(ctx, {
    purpose: "count things",
    sql_reads: ["SELECT count(*) AS n, city FROM bookings GROUP BY city"],
    python_code: "result = rows[0]['rows'][0]['nn']",
  }) as Promise<{ data: { reads: Record<string, unknown>[]; compute: Record<string, unknown> } }>;

beforeEach(() => {
  runCodeActReads.mockClear();
});

describe("codeact compute failure", () => {
  it("returns the column names of each read so the model can fix its Python", async () => {
    computeResult = { ok: false, error: "KeyError", message: "'nn'" };
    const out = await call();
    expect(out.data.reads[0].columns).toEqual(["n", "city"]);
  });

  it("tells the model the SQL was fine and to retry the same query", async () => {
    computeResult = { ok: false, error: "KeyError", message: "'nn'" };
    const out = await call();
    expect(String(out.data.compute.retry_hint)).toMatch(/SAME sql_reads/);
  });

  it("still exposes no row VALUES — only names, which the catalog already publishes", async () => {
    computeResult = { ok: false, error: "KeyError", message: "'nn'" };
    const out = await call();
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("Los Angeles");
    expect(serialized).not.toContain("41");
  });

  it("says so plainly when a read matched no rows, instead of claiming it returned some", async () => {
    runCodeActReads.mockImplementationOnce(async () => [
      { index: 0, row_count: 0, row_count_exact: true, truncated: false, rows: [] },
    ]);
    computeResult = { ok: false, error: "IndexError", message: "list index out of range" };
    const out = await call();
    expect(out.data.reads[0].columns).toEqual([]);
    expect(String(out.data.compute.retry_hint)).toMatch(/empty when that read matched no rows/);
    expect(String(out.data.compute.retry_hint)).not.toMatch(/returned rows;/);
  });

  it("adds nothing at all when the compute succeeded", async () => {
    computeResult = { ok: true, result: 58 };
    const out = await call();
    expect(out.data.reads[0]).not.toHaveProperty("columns");
    expect(out.data.compute).not.toHaveProperty("retry_hint");
  });
});
