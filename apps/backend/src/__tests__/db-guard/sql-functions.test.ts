import { describe, it, expect } from "vitest";
import { isAllowedFunction } from "@zavi/shared/db-guard";

describe("isAllowedFunction", () => {
  it.each(["count", "COUNT", "date_trunc", "coalesce", "row_number"])("postgres allows %s", (f) =>
    expect(isAllowedFunction(f, "postgres")).toBe(true),
  );
  it.each(["pg_read_file", "pg_ls_dir", "lo_import", "dblink", "set_config", "current_setting", "query_to_xml", "pg_sleep", "my_custom_fn", "generate_series"])(
    "postgres refuses %s",
    (f) => expect(isAllowedFunction(f, "postgres")).toBe(false),
  );
  it.each(["load_file", "LOAD_FILE", "sys_eval", "sleep", "benchmark", "my_custom_fn"])("mysql refuses %s", (f) =>
    expect(isAllowedFunction(f, "mysql")).toBe(false),
  );
  it("dialect split: date_format is MySQL only, date_trunc Postgres only", () => {
    expect(isAllowedFunction("date_format", "mysql")).toBe(true);
    expect(isAllowedFunction("date_format", "postgres")).toBe(false);
    expect(isAllowedFunction("date_trunc", "mysql")).toBe(false);
  });
});
