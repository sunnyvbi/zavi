import { describe, it, expect } from "vitest";
import { mysqlVerdict, pgVerdict } from "../discovery/privilege";

const clean = {
  rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false, rolreplication: false,
  write_all_data: false, db_create: false, schema_create: false, table_write: false,
};

describe("pgVerdict", () => {
  it("a login with no capability reads only", () => {
    expect(pgVerdict(clean)).toBe("false");
  });
  it.each(Object.keys(clean))("%s alone makes it a writer", (flag) => {
    expect(pgVerdict({ ...clean, [flag]: true })).toBe("true");
  });
  it("an INHERITED writer role (table_write via has_table_privilege) is a writer", () => {
    expect(pgVerdict({ ...clean, table_write: true })).toBe("true");
  });
  it("a missing row or a NULL flag is unknown, never 'reads only'", () => {
    expect(pgVerdict(undefined)).toBe("unknown");
    expect(pgVerdict({ ...clean, schema_create: null })).toBe("unknown");
  });
});

describe("mysqlVerdict", () => {
  it("SELECT-only grants read only", () => {
    expect(mysqlVerdict(["GRANT USAGE ON *.* TO `zavi_reader`@`%`", "GRANT SELECT, SHOW VIEW ON `shop`.* TO `zavi_reader`@`%`"])).toBe("false");
  });
  it.each([
    "GRANT SELECT, CREATE ON `shop`.* TO `u`@`%`",
    "GRANT ALTER ON `shop`.`orders` TO `u`@`%`",
    "GRANT DROP ON *.* TO `u`@`%`",
    "GRANT ALL PRIVILEGES ON `shop`.* TO `u`@`%`",
    "GRANT INSERT (`email`) ON `shop`.`users` TO `u`@`%`",
    "GRANT SUPER ON *.* TO `u`@`%`",
    "GRANT SELECT ON `shop`.* TO `u`@`%` WITH GRANT OPTION",
  ])("a DDL / DML / admin grant is a writer: %s", (line) => {
    expect(mysqlVerdict(["GRANT USAGE ON *.* TO `u`@`%`", line])).toBe("true");
  });
  it("a role grant hides the role's privileges: unknown", () => {
    expect(mysqlVerdict(["GRANT USAGE ON *.* TO `u`@`%`", "GRANT `app_rw`@`%` TO `u`@`%`"])).toBe("unknown");
  });
  it("no lines: unknown", () => {
    expect(mysqlVerdict([])).toBe("unknown");
  });
  it("column-level SELECT reads only", () => {
    expect(mysqlVerdict(["GRANT SELECT (`id`, `plan`) ON `shop`.`users` TO `u`@`%`"])).toBe("false");
  });
});
