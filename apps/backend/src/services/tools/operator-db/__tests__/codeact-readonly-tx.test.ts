import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExpectedToolError } from "@/services/tools/types";

const pgQueries: string[] = [];
const pgConnect = vi.fn(async () => undefined);
const pgEnd = vi.fn(async () => undefined);
const pgQuery = vi.fn(async (sql: string) => {
  pgQueries.push(sql);
  return { rows: [{ n: 1 }] };
});

vi.mock("pg", () => ({
  Client: class {
    constructor(public opts: unknown) {}
    connect = pgConnect;
    end = pgEnd;
    query = pgQuery;
  },
  types: { getTypeParser: () => (v: unknown) => v },
}));

vi.mock("mysql2/promise", () => ({
  createConnection: vi.fn(async () => ({
    query: vi.fn(async () => [[]]),
    end: vi.fn(async () => undefined),
  })),
}));

import { runCodeActReads as runOnSession, CODEACT_STATEMENT_TIMEOUT_MS, type CodeActReadOptions } from "../codeact-sql";
import { openSqlSession } from "@/services/data-gateway/direct/sql";
import type { ReadSession } from "@/services/data-gateway/session";

async function runCodeActReads(dialect: "postgres" | "mysql", conn: string, reads: string[], opts: CodeActReadOptions = {}) {
  const session = await openSqlSession(dialect, conn, { statementTimeoutMs: CODEACT_STATEMENT_TIMEOUT_MS, timeZone: opts.timeZone });
  try {
    return await runOnSession(session, reads, opts);
  } finally {
    await session.close();
  }
}
function fakeSession(dialect: ReadSession["dialect"]): ReadSession & { query: ReturnType<typeof vi.fn> } {
  return {
    dialect,
    query: vi.fn(),
    mongo: vi.fn(),
    dynamo: vi.fn(),
    sessionTimeZone: () => undefined,
    largestTableRows: async () => null,
    close: async () => undefined,
  } as never;
}

beforeEach(() => {
  pgQueries.length = 0;
  pgConnect.mockClear();
  pgEnd.mockClear();
  pgQuery.mockClear();
});

describe("codeact-sql · read-only transaction wrap (security)", () => {
  it("issues BEGIN TRANSACTION READ ONLY + statement_timeout before the user query", async () => {
    await runCodeActReads("postgres", "postgres://stays-in-backend", ["SELECT count(*) FROM users"]);
    const idxBegin = pgQueries.findIndex((q) => /BEGIN TRANSACTION READ ONLY/i.test(q));
    const idxTimeout = pgQueries.findIndex((q) => /SET LOCAL statement_timeout/i.test(q));
    const idxUser = pgQueries.findIndex((q) => /SELECT count\(\*\) FROM users/i.test(q));
    expect(idxBegin).toBeGreaterThanOrEqual(0);
    expect(idxTimeout).toBeGreaterThanOrEqual(0);
    expect(idxUser).toBeGreaterThanOrEqual(0);
    expect(idxBegin).toBeLessThan(idxUser);
    expect(idxTimeout).toBeLessThan(idxUser);
  });

  it("passes the statement_timeout into the pg Client opts too", async () => {
    expect(CODEACT_STATEMENT_TIMEOUT_MS).toBeGreaterThan(0);
    await runCodeActReads("postgres", "postgres://x", ["SELECT 1"]);
    expect(pgConnect).toHaveBeenCalledTimes(1);
    expect(pgEnd).toHaveBeenCalledTimes(1);
  });

  it("rejects a write before any read reaches the session (statement-kind guard)", async () => {
    const s = fakeSession("postgres");
    await expect(runOnSession(s, ["DELETE FROM users"])).rejects.toBeInstanceOf(ExpectedToolError);
    expect(s.query).not.toHaveBeenCalled();
  });

  it("refuses mongo operator DBs (no SQL surface)", async () => {
    await expect(runOnSession(fakeSession("mongodb"), ["SELECT 1"])).rejects.toBeInstanceOf(ExpectedToolError);
  });
});
