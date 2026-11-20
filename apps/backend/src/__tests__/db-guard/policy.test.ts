import { describe, it, expect } from "vitest";
import { effectivePolicy, policyFromRules, type CatalogLike } from "@zavi/shared/db-guard";

const catalog: CatalogLike = {
  tables: [
    { name: "users", columns: [{ name: "id" }, { name: "email" }, { name: "role" }, { name: "name" }] },
    { name: "bookings", columns: [{ name: "id" }, { name: "city" }, { name: "note" }] },
  ],
};
const base = { auto_hide: false, hidden_fields: [], unhidden_fields: [], disabled_tables: [] };

describe("effectivePolicy", () => {
  it("legacy row hides nothing and allows catalog tables", () => {
    const p = effectivePolicy(base, catalog);
    expect(p.isAllowed("users")).toBe(true);
    expect(p.isHidden("users", "email")).toBe(false);
    expect(p.visibleColumns("users")).toEqual(["id", "email", "role", "name"]);
  });
  it("auto_hide hides detected fields", () => {
    const p = effectivePolicy({ ...base, auto_hide: true }, catalog);
    expect(p.isHidden("users", "email")).toBe(true);
    expect(p.isHidden("users", "Email")).toBe(true);
    expect(p.isHidden("users", "name")).toBe(true);
    expect(p.isHidden("users", "role")).toBe(false);
    expect(p.visibleColumns("users")).toEqual(["id", "role"]);
  });
  it("explicit un-hide wins over auto_hide; explicit hide adds", () => {
    const p = effectivePolicy(
      { ...base, auto_hide: true, unhidden_fields: ["users.email"], hidden_fields: ["bookings.note"] },
      catalog,
    );
    expect(p.isHidden("users", "email")).toBe(false);
    expect(p.isHidden("bookings", "note")).toBe(true);
    expect(p.hiddenFields("bookings")).toEqual(["note"]);
  });
  it("a table absent from the catalog is NOT allowed (default deny)", () => {
    const p = effectivePolicy(base, catalog);
    expect(p.isAllowed("audit_logs")).toBe(false);
    expect(p.resolve("audit_logs")).toBeNull();
  });
  it("a switched-off table is not allowed", () => {
    const p = effectivePolicy({ ...base, disabled_tables: ["bookings"] }, catalog);
    expect(p.isAllowed("bookings")).toBe(false);
    expect(p.isAllowed("users")).toBe(true);
  });
});

describe("table resolution mirrors the database's identifier rules", () => {
  const one: CatalogLike = { tables: [{ name: "users", columns: [{ name: "id" }] }] };
  it("Mongo: exact case only ('Users' is a different collection)", () => {
    const p = effectivePolicy(base, one, "mongodb");
    expect(p.isAllowed("users")).toBe(true);
    expect(p.isAllowed("Users")).toBe(false);
  });
  it("DynamoDB: exact case only", () => {
    expect(effectivePolicy(base, one, "dynamodb").isAllowed("USERS")).toBe(false);
  });
  it("Postgres: unquoted Users folds to users; quoted \"Users\" is refused", () => {
    const p = effectivePolicy(base, one, "postgres");
    expect(p.resolve("Users", false)?.name).toBe("users");
    expect(p.resolve("Users", true)).toBeNull();
    expect(p.resolve("users", true)?.name).toBe("users");
  });
  it("Postgres: a catalog table named Users (mixed case) is reachable only quoted", () => {
    const p = effectivePolicy(base, { tables: [{ name: "Users", columns: [] }] }, "postgres");
    expect(p.isAllowed("Users", false)).toBe(false);
    expect(p.isAllowed("Users", true)).toBe(true);
  });
  it("MySQL unquoted: exact, else the single case-insensitive match; two variants -> exact only", () => {
    expect(effectivePolicy(base, one, "mysql").resolve("USERS")?.name).toBe("users");
    const two: CatalogLike = { tables: [{ name: "Users", columns: [] }, { name: "users", columns: [] }] };
    const p = effectivePolicy(base, two, "mysql");
    expect(p.resolve("USERS")).toBeNull();
    expect(p.resolve("users")?.name).toBe("users");
    expect(p.resolve("Users", true)?.name).toBe("Users");
    expect(p.resolve("USERS", true)).toBeNull();
  });
  it("a disabled exact match is never replaced by an allowed case-variant", () => {
    const two: CatalogLike = { tables: [{ name: "Users", columns: [] }, { name: "users", columns: [] }] };
    const p = effectivePolicy(base, two, "mysql");
    const onlyUsers = effectivePolicy(base, { tables: [{ name: "Users", columns: [] }] }, "mysql");
    expect(p.resolve("Users")?.name).toBe("Users");
    expect(onlyUsers.resolve("users")?.name).toBe("Users");
    const d = effectivePolicy({ ...base, disabled_tables: ["Users"] }, two, "mysql");
    expect(d.isAllowed("Users")).toBe(false);
    expect(d.isAllowed("users")).toBe(false);
  });
  it("hidden-field matching is case-insensitive (can only hide more)", () => {
    const p = effectivePolicy({ ...base, hidden_fields: ["users.email"] }, catalog, "mongodb");
    expect(p.isHidden("users", "EMAIL")).toBe(true);
  });
});

describe("policyFromRules", () => {
  it("allows only listed tables and hides blocked columns", () => {
    const p = policyFromRules(
      { allowed: ["bookings"], blocked: ["bookings.note"], what_can_leave: "rows_without_blocked_columns", max_rows: 200 },
      catalog,
    );
    expect(p.isAllowed("bookings")).toBe(true);
    expect(p.isAllowed("users")).toBe(false);
    expect(p.isHidden("bookings", "note")).toBe(true);
    expect(p.visibleColumns("bookings")).toEqual(["id", "city"]);
  });
});

describe("restrictions win on ambiguity, permissions lose", () => {
  const two: CatalogLike = {
    tables: [
      { name: "users", columns: [{ name: "id" }, { name: "email" }] },
      { name: "USERS", columns: [{ name: "id" }, { name: "email" }] },
    ],
  };
  it("disabled ['Users'] refuses both variants", () => {
    const p = effectivePolicy({ ...base, disabled_tables: ["Users"] }, two);
    expect(p.isAllowed("users")).toBe(false);
    expect(p.isAllowed("USERS")).toBe(false);
  });
  it("hidden ['Users.email'] hides email in both", () => {
    const p = effectivePolicy({ ...base, hidden_fields: ["Users.email"] }, two);
    expect(p.isHidden("users", "email")).toBe(true);
    expect(p.isHidden("USERS", "email")).toBe(true);
  });
  it("connector blocked ['Users.email'] hides email in both", () => {
    const p = policyFromRules(
      { allowed: ["users", "USERS"], blocked: ["Users.email"], what_can_leave: "rows_without_blocked_columns", max_rows: 200 },
      two,
    );
    expect(p.isHidden("users", "email")).toBe(true);
    expect(p.isHidden("USERS", "email")).toBe(true);
  });
  it("connector allowed ['Users'] allows neither", () => {
    const p = policyFromRules({ allowed: ["Users"], blocked: [], what_can_leave: "rows_without_blocked_columns", max_rows: 200 }, two);
    expect(p.isAllowed("users")).toBe(false);
    expect(p.isAllowed("USERS")).toBe(false);
  });
  it("unhidden ['Users.email'] leaves email hidden", () => {
    const p = effectivePolicy({ ...base, auto_hide: true, unhidden_fields: ["Users.email"] }, two);
    expect(p.isHidden("users", "email")).toBe(true);
    expect(p.isHidden("USERS", "email")).toBe(true);
  });
  it("exact-case un-hide still works", () => {
    const p = effectivePolicy({ ...base, auto_hide: true, unhidden_fields: ["users.email"] }, two);
    expect(p.isHidden("users", "email")).toBe(false);
    expect(p.isHidden("USERS", "email")).toBe(true);
  });
});

