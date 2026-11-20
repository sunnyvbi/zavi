import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { applyMysqlStatementTimeout } from "../mysql-session";

const unknownVar = () => {
  throw Object.assign(new Error("Unknown system variable 'MAX_EXECUTION_TIME'"), {
    code: "ER_UNKNOWN_SYSTEM_VARIABLE",
  });
};

describe("applyMysqlStatementTimeout", () => {
  it("uses MAX_EXECUTION_TIME in MILLISECONDS on MySQL", async () => {
    const q = vi.fn(async (_sql: string) => undefined);
    expect(await applyMysqlStatementTimeout(q, 5000)).toBe("mysql");
    expect(q).toHaveBeenCalledTimes(1);
    expect(q.mock.calls[0][0]).toBe("SET SESSION MAX_EXECUTION_TIME = 5000");
  });

  it("falls back to max_statement_time on MariaDB", async () => {
    const q = vi.fn(async (sql: string) => {
      if (sql.includes("MAX_EXECUTION_TIME")) unknownVar();
      return undefined;
    });
    expect(await applyMysqlStatementTimeout(q, 5000)).toBe("mariadb");
    expect(q).toHaveBeenCalledTimes(2);
  });

  it("MariaDB fallback is in SECONDS — milliseconds would be an 83-minute 'timeout'", async () => {
    const q = vi.fn(async (sql: string) => {
      if (sql.includes("MAX_EXECUTION_TIME")) unknownVar();
      return undefined;
    });
    await applyMysqlStatementTimeout(q, 5000);
    expect(q.mock.calls[1][0]).toBe("SET SESSION max_statement_time = 5");
    expect(q.mock.calls[1][0]).not.toMatch(/= ?5000/);
  });

  it("returns 'none' and NEVER throws when neither spelling exists", async () => {
    const q = vi.fn(async (_sql: string) => unknownVar());
    await expect(applyMysqlStatementTimeout(q, 5000)).resolves.toBe("none");
  });

  it("handles fractional millisecond budgets without emitting garbage", async () => {
    const q = vi.fn(async (sql: string) => {
      if (sql.includes("MAX_EXECUTION_TIME")) unknownVar();
      return undefined;
    });
    await applyMysqlStatementTimeout(q, 2500);
    expect(q.mock.calls[1][0]).toBe("SET SESSION max_statement_time = 2.5");
  });
});

describe("no unguarded MAX_EXECUTION_TIME anywhere in the backend", () => {
  const SRC = join(__dirname, "..", "..", "..", "..");

  function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "__tests__") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (p.endsWith(".ts")) out.push(p);
    }
    return out;
  }

  it("every session-level SET goes through applyMysqlStatementTimeout", () => {
    const offenders: string[] = [];
    const HELPER = join("services", "tools", "operator-db", "mysql-session.ts");
    for (const f of walk(SRC)) {
      if (f.endsWith(HELPER)) continue;
      const src = readFileSync(f, "utf-8");
      for (const line of src.split("\n")) {
        if (!/SET\s+SESSION\s+MAX_EXECUTION_TIME/i.test(line)) continue;
        offenders.push(`${f.replace(SRC, "")}: ${line.trim().slice(0, 80)}`);
      }
    }
    expect(offenders, `Use applyMysqlStatementTimeout() — a bare SET breaks MariaDB:\n${offenders.join("\n")}`).toEqual([]);
  });
});

const MARIADB_URL = process.env.OPERATOR_DB_E2E_MARIADB_URL;

describe.skipIf(!MARIADB_URL)("MariaDB (live)", () => {
  it("discovery completes end to end", async () => {
    const { introspectMysql } = await import("@/services/data-gateway/discovery/mysql");
    const { probeConnectivity } = await import("@/services/data-gateway/discovery/run");
    const probe = await probeConnectivity("mysql", MARIADB_URL!);
    expect(probe.ok).toBe(true);
    const raw = await introspectMysql(MARIADB_URL!, 100, Date.now() + 60_000);
    expect(raw.tables.length).toBeGreaterThan(0);
    expect(raw.tables.every((t) => t.columns.length > 0)).toBe(true);
  }, 120_000);

  it("the fallback bound is real — a slow query is killed", async () => {
    const { createConnection } = await import("mysql2/promise");
    const c = await createConnection(MARIADB_URL!);
    try {
      expect(await applyMysqlStatementTimeout((sql) => c.query(sql), 1000)).toBe("mariadb");
      const t0 = Date.now();
      await expect(c.query("SELECT SLEEP(10)")).rejects.toThrow(/interrupted|exceeded/i);
      expect(Date.now() - t0).toBeLessThan(4000);
    } finally {
      await c.end().catch(() => undefined);
    }
  }, 60_000);
});
