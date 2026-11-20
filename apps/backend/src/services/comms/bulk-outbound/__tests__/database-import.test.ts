import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExpectedToolError } from "@/services/tools/types";

const mocks = vi.hoisted(() => ({ list: vi.fn(), read: vi.fn(), log: vi.fn() }));
vi.mock("@/services/data-gateway/person", () => ({
  listContactImportTables: (...a: unknown[]) => mocks.list(...a),
  readContactColumn: (...a: unknown[]) => mocks.read(...a),
}));

import { buildColumnRead, listImportTables, readDatabaseColumn } from "../database-import";
import { BulkEmailError } from "../errors";

const TABLES = [
  { name: "Users", columns: [{ name: "id", type: "uuid" }, { name: "Email", type: "text" }] },
  { name: "orders", columns: [{ name: "total", type: "numeric" }] },
];
const CTX = { tenant_id: "tenant-a", caller: { kind: "person", user_id: "u-1", feature: "Contact import" } };

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as BulkEmailError).code;
  }
  return "no_error";
}

describe("database import", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.list.mockResolvedValue(TABLES);
    mocks.read.mockResolvedValue({ values: ["ada@example.com", "bo@example.com"], truncated: false, dialect: "postgres", table: "Users", field: "Email" });
    vi.spyOn(console, "log").mockImplementation(mocks.log);
    vi.spyOn(console, "warn").mockImplementation(mocks.log);
    vi.spyOn(console, "error").mockImplementation(mocks.log);
  });

  it("lists table and column names and types only, as the signed-in person", async () => {
    expect(await listImportTables("tenant-a", "u-1")).toEqual(TABLES);
    expect(mocks.list).toHaveBeenCalledWith(CTX);
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("reads only the one column, by its exact catalog name, as a Contact import", async () => {
    const out = await readDatabaseColumn({ tenantId: "tenant-a", userId: "u-1", table: "users", column: "email" });
    expect(mocks.read).toHaveBeenCalledTimes(1);
    expect(mocks.read).toHaveBeenCalledWith(CTX, "Users", "Email", 5000);
    expect(out).toMatchObject({ db_type: "postgres", table: "Users", column: "Email", truncated: false });
    expect(out.values).toEqual(["ada@example.com", "bo@example.com"]);
  });

  it("quotes for MySQL with backticks", () => {
    expect(buildColumnRead("mysql", "shop.users", "email")).toBe("SELECT `email` FROM `shop`.`users` WHERE `email` IS NOT NULL LIMIT 5001");
  });

  it("refuses a table Zavi may not read, and a column that table does not have", async () => {
    expect(await codeOf(readDatabaseColumn({ tenantId: "t", userId: "u", table: "secrets", column: "email" }))).toBe("database_table_not_found");
    expect(await codeOf(readDatabaseColumn({ tenantId: "t", userId: "u", table: "users", column: "password" }))).toBe("database_column_not_found");
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("refuses a name that is not a plain identifier, and never reads with one", async () => {
    mocks.list.mockResolvedValue([
      { name: 'users"; drop table x; --', columns: [{ name: "email", type: "text" }] },
      { name: "people", columns: [{ name: 'e"mail', type: "text" }] },
    ]);
    expect(await codeOf(readDatabaseColumn({ tenantId: "t", userId: "u", table: 'users"; drop table x; --', column: "email" }))).toBe("database_bad_name");
    expect(await codeOf(readDatabaseColumn({ tenantId: "t", userId: "u", table: "people", column: 'e"mail' }))).toBe("database_bad_name");
    expect(() => buildColumnRead("postgres", "users; drop", "email")).toThrow(BulkEmailError);
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("passes truncation through; DynamoDB is not supported; not connected maps to 409", async () => {
    mocks.read.mockResolvedValueOnce({ values: ["a@b.co"], truncated: true, dialect: "postgres", table: "Users", field: "Email" });
    expect((await readDatabaseColumn({ tenantId: "t", userId: "u", table: "users", column: "email" })).truncated).toBe(true);
    mocks.read.mockRejectedValueOnce(new ExpectedToolError("operator_db_unsupported_dialect", "x"));
    expect(await codeOf(readDatabaseColumn({ tenantId: "t", userId: "u", table: "users", column: "email" }))).toBe("database_not_supported");
    mocks.list.mockRejectedValueOnce(new ExpectedToolError("operator_db_not_connected", "x"));
    expect(await codeOf(readDatabaseColumn({ tenantId: "t", userId: "u", table: "users", column: "email" }))).toBe("database_not_connected");
  });

  it("must catch: a passing failure to read the table list at Import time is not 'connect your database first'", async () => {
    mocks.list.mockRejectedValueOnce(new Error("fetch failed: socket hang up ada@example.com"));
    let err: BulkEmailError | null = null;
    try {
      await readDatabaseColumn({ tenantId: "t", userId: "u", table: "users", column: "email" });
    } catch (e) {
      err = e as BulkEmailError;
    }
    expect(err).toBeInstanceOf(BulkEmailError);
    expect(err!.code).toBe("database_read_failed");
    expect(err!.message).not.toMatch(/connect your database/i);
    expect(err!.message).not.toContain("ada@example.com");
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("never logs a value, and never passes a driver's message on", async () => {
    mocks.read.mockRejectedValue(new Error('syntax error near "ada@example.com"'));
    let message = "";
    try {
      await readDatabaseColumn({ tenantId: "t", userId: "u", table: "users", column: "email" });
    } catch (e) {
      message = (e as Error).message;
      expect((e as BulkEmailError).code).toBe("database_read_failed");
    }
    expect(message).not.toContain("ada@example.com");
    expect(JSON.stringify(mocks.log.mock.calls)).not.toContain("example.com");
  });
});
