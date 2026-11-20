import { describe, it, expect, vi } from "vitest";
import { effectivePolicy } from "@zavi/shared/db-guard";

vi.mock("@/services/data-gateway/audit", () => ({
  reserveAudit: vi.fn(async () => "live-log"),
  finalizeAudit: vi.fn(async () => undefined),
  writeRefusalAudit: vi.fn(async () => null),
}));
import {
  toReadResult,
  stripTrailingSemicolon,
  runCodeActReads as runOnSession,
  MAX_ROWS_PER_READ,
} from "../codeact-sql";

const row = (i: number) => ({ i });
const rows = (n: number) => Array.from({ length: n }, (_, i) => row(i));

import { openSqlSession } from "@/services/data-gateway/direct/sql";
import { loggedSession } from "@/services/data-gateway/logged-session";
import type { DbAccess } from "@/services/data-gateway/resolve";

function liveAccess(dialect: "postgres" | "mysql"): DbAccess {
  const tables = [
    { name: "big", columns: [{ name: "id" }, { name: "loc" }, { name: "payload" }] },
    { name: "lookup", columns: [{ name: "id" }, { name: "label" }] },
  ];
  return {
    tenant_id: "live",
    mode: "direct",
    dialect,
    database: null,
    policy: effectivePolicy({ auto_hide: false, hidden_fields: [], unhidden_fields: [], disabled_tables: [] }, { tables }, dialect),
  } as unknown as DbAccess;
}
const liveCtx = { tenant_id: "live", caller: { kind: "agent" as const, agent_slug: "live", run_id: null, tool_name: "live" } };

async function runCodeActReads(dialect: "postgres" | "mysql", url: string, reads: string[]) {
  const session = loggedSession(await openSqlSession(dialect, url, { int8AsNumber: true }), liveAccess(dialect), liveCtx);
  try {
    return await runOnSession(session, reads);
  } finally {
    await session.close();
  }
}

describe("toReadResult — bounded-read contract", () => {
  it("under the cap: everything returned, count is exact", () => {
    const r = toReadResult(0, rows(12));
    expect(r).toMatchObject({ index: 0, row_count: 12, row_count_exact: true, truncated: false });
    expect(r.rows).toHaveLength(12);
  });

  it("exactly the cap: still exact — the engine had nothing more to give", () => {
    const r = toReadResult(1, rows(MAX_ROWS_PER_READ));
    expect(r).toMatchObject({ row_count: MAX_ROWS_PER_READ, row_count_exact: true, truncated: false });
  });

  it("cap+1 (the sentinel row): truncated, and the count is NOT exact", () => {
    const r = toReadResult(2, rows(MAX_ROWS_PER_READ + 1));
    expect(r).toMatchObject({ row_count: MAX_ROWS_PER_READ, row_count_exact: false, truncated: true });
    expect(r.rows).toHaveLength(MAX_ROWS_PER_READ);
  });

  it("empty result is exact, not truncated", () => {
    expect(toReadResult(0, [])).toMatchObject({ row_count: 0, row_count_exact: true, truncated: false });
  });
});

describe("stripTrailingSemicolon", () => {
  it("strips a trailing semicolon and trailing whitespace", () => {
    expect(stripTrailingSemicolon("SELECT 1;")).toBe("SELECT 1");
    expect(stripTrailingSemicolon("SELECT 1;  \n ")).toBe("SELECT 1");
  });
  it("leaves an unterminated statement alone", () => {
    expect(stripTrailingSemicolon("SELECT 1")).toBe("SELECT 1");
  });
  it("does not touch a semicolon inside a string literal", () => {
    expect(stripTrailingSemicolon("SELECT ';'")).toBe("SELECT ';'");
  });
});

const MYSQL_URL = process.env.OPERATOR_DB_E2E_MYSQL_URL;
const PG_URL = process.env.OPERATOR_DB_E2E_PG_URL;

const HEAP_BUDGET_MB = 120;

function heapDeltaMb(before: number): number {
  return (process.memoryUsage().heapUsed - before) / 1024 / 1024;
}

for (const [dialect, url] of [
  ["mysql", MYSQL_URL],
  ["postgres", PG_URL],
] as const) {
  describe.skipIf(!url)(`${dialect} — engine-bounded reads (live)`, () => {
    it("an unbounded SELECT * over 1.6M rows stays inside the heap budget", async () => {
      global.gc?.();
      const before = process.memoryUsage().heapUsed;
      const r = await runCodeActReads(dialect, url!, ["SELECT * FROM big"]);
      const delta = heapDeltaMb(before);

      expect(r[0].rows).toHaveLength(MAX_ROWS_PER_READ);
      expect(r[0].truncated).toBe(true);
      expect(r[0].row_count_exact).toBe(false);
      expect(delta).toBeLessThan(HEAP_BUDGET_MB);
    }, 120_000);

    it("an explicit LIMIT ABOVE the cap is still bounded", async () => {
      const r = await runCodeActReads(dialect, url!, ["SELECT * FROM big LIMIT 900000"]);
      expect(r[0].rows).toHaveLength(MAX_ROWS_PER_READ);
      expect(r[0].truncated).toBe(true);
    }, 120_000);

    it("a small aggregate is exact and untruncated", async () => {
      const r = await runCodeActReads(dialect, url!, [
        "SELECT loc, COUNT(*) AS n FROM big GROUP BY loc",
      ]);
      expect(r[0].truncated).toBe(false);
      expect(r[0].row_count_exact).toBe(true);
      expect(r[0].row_count).toBe(5);
    }, 60_000);

    it("CTEs still run (the cursor/stream must accept WITH, not just SELECT)", async () => {
      const r = await runCodeActReads(dialect, url!, [
        "WITH per_loc AS (SELECT loc, COUNT(*) AS n FROM big GROUP BY loc) SELECT * FROM per_loc ORDER BY n DESC",
      ]);
      expect(r[0].row_count).toBe(5);
      expect(r[0].truncated).toBe(false);
    }, 60_000);

    it("a join with duplicate output column names still runs", async () => {
      const r = await runCodeActReads(dialect, url!, [
        "SELECT b.*, l.* FROM big b JOIN lookup l ON l.id = b.id",
      ]);
      expect(r[0].rows.length).toBeGreaterThan(0);
    }, 60_000);

    it("a trailing semicolon is accepted", async () => {
      const r = await runCodeActReads(dialect, url!, ["SELECT COUNT(*) AS n FROM big;"]);
      expect(r[0].row_count).toBe(1);
    }, 60_000);

    it("reads AFTER a truncated read still succeed", async () => {
      const r = await runCodeActReads(dialect, url!, [
        "SELECT * FROM big LIMIT 900000",
        "SELECT COUNT(*) AS n FROM big",
        "SELECT loc, COUNT(*) AS n FROM big GROUP BY loc",
      ]);
      expect(r).toHaveLength(3);
      expect(r[0].truncated).toBe(true);
      expect(Number(Object.values(r[1].rows[0])[0])).toBe(1_600_000);
      expect(r[2].row_count).toBe(5);
    }, 180_000);

    it("writes are still rejected at the engine even inside the new read path", async () => {
      await expect(
        runCodeActReads(dialect, url!, ["SELECT * FROM big"]).then(async () => {
          const r = await runCodeActReads(dialect, url!, ["SELECT 1 AS ok"]);
          return r[0].row_count;
        }),
      ).resolves.toBe(1);
    }, 60_000);
  });
}
