
import { describe, it, expect } from "vitest";
import { findUsersTable } from "./WebsiteConsole";

type Col = { name: string; type: string };
const EMAIL: Col[] = [{ name: "email", type: "text" }];
const table = (name: string, columns: Col[] = EMAIL) => ({
  name,
  row_estimate: null,
  columns,
});

describe("findUsersTable", () => {
  it("finds the plain `users` table — the case the entities lookup broke", () => {
    const tables = [table("posts"), table("users"), table("comments")];
    expect(findUsersTable(tables)?.name).toBe("users");
  });

  it("is case-insensitive (Postgres identifiers can be folded either way)", () => {
    expect(findUsersTable([table("Users")])?.name).toBe("Users");
  });

  it("prefers the more specific name when several candidates exist", () => {
    const tables = [table("accounts"), table("users")];
    expect(findUsersTable(tables)?.name).toBe("users");
  });

  it("falls back to a suffixed variant like app_users / auth_users", () => {
    expect(findUsersTable([table("posts"), table("auth_users")])?.name).toBe("auth_users");
  });

  it("returns null when the app genuinely has no users table", () => {
    expect(findUsersTable([table("posts"), table("comments")])).toBeNull();
  });

  it("returns null on an empty catalog rather than throwing", () => {
    expect(findUsersTable([])).toBeNull();
  });

  it("carries the matched table's columns through for the extra-columns row", () => {
    const cols = [{ name: "email", type: "text" }, { name: "plan", type: "text" }];
    expect(findUsersTable([table("users", cols)])?.columns).toEqual(cols);
  });

  it("REJECTS a name match with no user-shaped column", () => {
    const ledger = table("accounts", [
      { name: "id", type: "uuid" },
      { name: "balance_cents", type: "integer" },
    ]);
    expect(findUsersTable([ledger])).toBeNull();
  });

  it("skips a non-user-shaped earlier candidate for a later one that qualifies", () => {
    const tables = [
      table("accounts", [{ name: "balance_cents", type: "integer" }]),
      table("profiles", [{ name: "full_name", type: "text" }]),
    ];
    expect(findUsersTable(tables)?.name).toBe("profiles");
  });

  it("accepts username / name / full_name, not just email", () => {
    expect(findUsersTable([table("users", [{ name: "username", type: "text" }])])?.name).toBe(
      "users",
    );
    expect(findUsersTable([table("users", [{ name: "full_name", type: "text" }])])?.name).toBe(
      "users",
    );
  });

  it("accepts every alias the tab can actually RENDER as name/email", () => {
    expect(
      findUsersTable([table("users", [{ name: "email_address", type: "text" }])])?.name,
    ).toBe("users");
    expect(
      findUsersTable([table("users", [{ name: "display_name", type: "text" }])])?.name,
    ).toBe("users");
  });

  it("applies the shape gate to the suffixed fallback too", () => {
    const tables = [table("auth_users", [{ name: "token_hash", type: "text" }])];
    expect(findUsersTable(tables)).toBeNull();
  });

  it("matches a mixed-case table name, though the READ of it may still fail", () => {
    expect(findUsersTable([table("Users")])?.name).toBe("Users");
  });
});
