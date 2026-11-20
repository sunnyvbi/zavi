import { describe, it, expect } from "vitest";
import { isDbToolName, DB_TOOL_NAME_SQL_REGEX } from "@zavi/shared/db-guard";

describe("isDbToolName", () => {
  it.each(["operator_db__query", "operator_db_query", "mcp__operator_db__codeact", "mcp__server__operator_db__query"])(
    "true for %s",
    (n) => expect(isDbToolName(n)).toBe(true),
  );
  it.each(["github__read_file", "mcp__server__memory__search", "my_operator_dbx__q", "", null, undefined])(
    "false for %s",
    (n) => expect(isDbToolName(n as string | null | undefined)).toBe(false),
  );
  it("SQL regex source is the same pattern", () => {
    expect(new RegExp(DB_TOOL_NAME_SQL_REGEX).test("mcp__operator_db__query")).toBe(true);
  });
});
