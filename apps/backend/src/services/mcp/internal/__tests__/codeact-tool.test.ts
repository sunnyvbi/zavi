import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExpectedToolError } from "@/services/tools/types";

const SECRET_CONN = "postgres://operator:supersecret@db.internal:5432/prod";

const FAKE_SESSION = { dialect: "postgres", __conn: SECRET_CONN };
const withReadSession = vi.fn(async (_ctx: unknown, fn: (s: unknown) => unknown, _opts?: unknown) => fn(FAKE_SESSION));
const resolveOperatorDb = withReadSession;

const runCodeActReads = vi.fn(async () => [
  { index: 0, row_count: 2, truncated: false, rows: [{ a: 1 }, { a: 2 }] },
]);

let lastPythonArgs: unknown = null;
const runCodeActPython = vi.fn(async (...a: unknown[]) => {
  lastPythonArgs = a[0];
  return { ok: true, result: { sum: 3 } };
});

vi.mock("@/services/data-gateway", () => ({
  withReadSession: (...a: unknown[]) => withReadSession(...(a as [never, never])),
}));
vi.mock("@/services/tools/operator-db/codeact-sql", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, runCodeActReads: (...a: unknown[]) => runCodeActReads(...(a as [])) };
});
vi.mock("@/services/analytics/tenant-timezone", () => ({
  resolveReportingTimezone: vi.fn(async () => ({ tz: "America/Chicago", source: "stored" })),
}));
vi.mock("@/services/sandbox/codeact-sandbox", () => ({
  runCodeActPython: (...a: unknown[]) => runCodeActPython(...(a as [])),
}));

const findSimilarVerifiedQueries = vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []);
const listActiveDataNotes = vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []);
vi.mock("@/services/analytics/verified-queries", () => ({
  findSimilarVerifiedQueries: (...a: unknown[]) => findSimilarVerifiedQueries(...a),
}));
vi.mock("@/services/analytics/data-notes", () => ({
  listActiveDataNotes: (...a: unknown[]) => listActiveDataNotes(...a),
}));

import { codeactTool } from "../codeact-tool";

const ctx = { tenant_id: "t1", log: vi.fn() };

beforeEach(() => {
  resolveOperatorDb.mockClear();
  runCodeActReads.mockClear();
  runCodeActPython.mockClear();
  lastPythonArgs = null;
});

describe("operator_db__codeact tool", () => {
  it("registers as 'operator_db_codeact'", () => {
    expect(codeactTool.name).toBe("operator_db_codeact");
  });

  it("never passes the connection string into the sandbox", async () => {
    await codeactTool.execute(ctx, {
      purpose: "sum a values",
      sql_reads: ["SELECT a FROM t"],
      python_code: "result = sum(r['a'] for r in rows[0]['rows'])",
    });
    expect(runCodeActPython).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify(lastPythonArgs);
    expect(serialized).not.toContain("supersecret");
    expect(serialized).not.toContain(SECRET_CONN);
    expect(serialized).not.toContain("OPERATOR_DB_URL");
    expect(serialized).toContain('"rows"');
  });

  it("redacts the rows by name before the sandbox sees them", async () => {
    runCodeActReads.mockResolvedValueOnce([
      { index: 0, row_count: 1, truncated: false, rows: [{ a: 1, email: "a@b.com", licence: "D1234567", city: "Austin" } as never] },
    ]);
    await codeactTool.execute(ctx, { purpose: "p", sql_reads: ["SELECT * FROM users"], python_code: "result = 1" });
    const serialized = JSON.stringify(lastPythonArgs);
    expect(serialized).not.toContain("a@b.com");
    expect(serialized).not.toContain("D1234567");
    expect(serialized).toContain("Austin");
  });

  it("redacts customer contact details quoted in saved questions and data notes", async () => {
    findSimilarVerifiedQueries.mockResolvedValueOnce([
      { question: "orders for a@b.com", sql_reads: ["SELECT count(*) FROM orders WHERE email = 'c@d.com' AND created_at > 1700000000"], created_at: "2026-10-01" },
    ]);
    listActiveDataNotes.mockResolvedValueOnce([{ metric_id: "m", note_text: "exclude 4155550100", created_at: "2026-10-01" }]);
    const r = (await codeactTool.execute(ctx, { purpose: "p", sql_reads: ["SELECT 1"], python_code: "result = 1" })) as { data: unknown };
    const text = JSON.stringify(r.data);
    expect(text).not.toContain("a@b.com");
    expect(text).not.toContain("4155550100");
    expect(text).not.toContain("c@d.com");
    expect(text).toContain("created_at > 1700000000");
  });

  it("rejects write SQL before resolving the DB or touching a sandbox", async () => {
    await expect(
      codeactTool.execute(ctx, {
        purpose: "evil",
        sql_reads: ["DELETE FROM users"],
        python_code: "result = 1",
      }),
    ).rejects.toBeInstanceOf(ExpectedToolError);
    expect(resolveOperatorDb).not.toHaveBeenCalled();
    expect(runCodeActPython).not.toHaveBeenCalled();
  });

  it("runs the reads on a gateway session as an agent caller (not the sandbox)", async () => {
    await codeactTool.execute({ ...ctx, agent_slug: "pm", run_id: "run-1" } as never, {
      purpose: "ok",
      sql_reads: ["SELECT 1"],
      python_code: "result = 1",
    });
    expect(runCodeActReads).toHaveBeenCalledWith(FAKE_SESSION, ["SELECT 1"], { timeZone: "America/Chicago" });
    expect(withReadSession.mock.calls[0]![0]).toEqual({
      tenant_id: "t1",
      caller: { kind: "agent", agent_slug: "pm", run_id: "run-1", tool_name: "operator_db__codeact" },
    });
    expect(withReadSession.mock.calls[0]![2]).toMatchObject({ timeZone: "America/Chicago", int8AsNumber: true });
  });

  it("returns compute result + read metadata (counts only, not raw secret state)", async () => {
    const out = (await codeactTool.execute(ctx, {
      purpose: "ok",
      sql_reads: ["SELECT 1"],
      python_code: "result = 1",
    })) as { ok: boolean; data: { reads: unknown[]; compute: { ok: boolean; result: unknown } } };
    expect(out.ok).toBe(true);
    expect(out.data.reads).toEqual([{ index: 0, row_count: 2, truncated: false }]);
    expect(out.data.compute.ok).toBe(true);
    expect(out.data.compute.result).toEqual({ sum: 3 });
    expect(out.data).not.toHaveProperty("verified_references");
    expect(out.data).not.toHaveProperty("data_notes");
  });

  it("offers the ctx tenant's similar verified queries and data notes; a lookup failure never fails the read", async () => {
    findSimilarVerifiedQueries.mockResolvedValueOnce([
      { id: "q1", question: "refunds by product", sql_reads: ["SELECT 1"], created_at: "2026-09-28T10:00:00Z", similarity: 0.9 },
    ]);
    listActiveDataNotes.mockRejectedValueOnce(new Error("db down"));
    const out = (await codeactTool.execute(ctx, {
      purpose: "refunds last month by product",
      sql_reads: ["SELECT 1"],
      python_code: "result = 1",
    })) as { ok: boolean; data: Record<string, unknown> };
    expect(findSimilarVerifiedQueries).toHaveBeenCalledWith("t1", "refunds last month by product");
    expect(listActiveDataNotes).toHaveBeenCalledWith("t1");
    expect(out.ok).toBe(true);
    expect(out.data.verified_references).toEqual([
      { question: "refunds by product", sql_reads: ["SELECT 1"], saved_at: "2026-09-28T10:00:00Z" },
    ]);
    expect(out.data).not.toHaveProperty("data_notes");
    expect(out.data.data_notes_warning).toMatch(/could not be read/);
  });

  it("labels its result exploratory", async () => {
    const out = (await codeactTool.execute(ctx, {
      purpose: "ok",
      sql_reads: ["SELECT 1"],
      python_code: "result = 1",
    })) as { data: { exploratory: boolean } };
    expect(out.data.exploratory).toBe(true);
  });
});
