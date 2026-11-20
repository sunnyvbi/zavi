import { describe, it, expect } from "vitest";
import { loginScript, removeScript } from "../readOnlyScripts";
import { dbTileDescription, dbTileMenu, dbTileState, CLOUD_MENU, CONNECTOR_MENU } from "../databaseTile";
import { visibilityBody } from "../DatabaseSeePanel";
import type { DbSetup } from "../databaseApi";

const cloud: DbSetup = { connected: true, mode: "direct", dialect: "postgres", legacy: false, managed_by: null, discovery: "ready", settings_confirmed: true };

describe("loginScript", () => {
  it("changes per database and per 'Zavi can read'", () => {
    expect(loginScript("postgres", "", "all", []).script).toContain("GRANT SELECT ON ALL TABLES IN SCHEMA public TO zavi_reader;");
    expect(loginScript("postgres", "", "pick", ["orders", "users"]).script).toContain('GRANT SELECT ON "orders", "users" TO zavi_reader;');
    expect(loginScript("mysql", "shop", "pick", ["orders"]).script).toContain("GRANT SELECT ON `shop`.`orders` TO 'zavi_reader'@'%';");
  });
});

const unquoted = (line: string) =>
  line.replace(/"(?:[^"]|"")*"/g, "Q").replace(/`(?:[^`]|``)*`/g, "Q");

const HOSTILE = ['x"; DROP TABLE users; --', "x`; DROP TABLE users; --", "x'); db.dropDatabase(); ('", 'a\\"b'];

describe("generated scripts escape every name", () => {
  it.each(HOSTILE)("postgres grant stays one statement: %s", (name) => {
    const { script, refused } = loginScript("postgres", "", "pick", [name]);
    expect(refused).toEqual([]);
    const grant = script.split("\n").find((l) => l.startsWith("GRANT SELECT ON "))!;
    expect(unquoted(grant)).toMatch(/^GRANT SELECT ON Q(\.Q)* TO zavi_reader;$/);
    expect(script).not.toMatch(/^DROP/m);
  });

  it.each(HOSTILE)("mysql grant stays one statement: %s", (name) => {
    const { script } = loginScript("mysql", "", "pick", [name]);
    const grant = script.split("\n").find((l) => l.startsWith("GRANT SELECT ON "))!;
    expect(unquoted(grant)).toBe("GRANT SELECT ON Q.Q TO 'zavi_reader'@'%';");
  });

  it.each(["x\nDROP TABLE users", "x\u0000y", "x\u2028y", "x\ry"])("a name with a control character is refused, never written: %j", (name) => {
    for (const db of ["postgres", "mysql"] as const) {
      const r = loginScript(db, "", "pick", [name]);
      expect(r.refused).toContain(name);
      expect(r.script).not.toContain("DROP TABLE users");
      expect(r.script).not.toContain("\u0000");
    }
    expect(removeScript("postgres", name, ["email"], ["id", "email"])).toEqual({ script: "", refused: [name] });
    expect(removeScript("postgres", "users", [name], ["id", name]).refused).toContain(name);
  });

  it("database name typed with a quote stays quoted", () => {
    expect(loginScript("postgres", 'shop"; DROP ROLE x; --', "all", []).script).toContain('GRANT CONNECT ON DATABASE "shop""; DROP ROLE x; --" TO zavi_reader;');
  });

  it.each(HOSTILE)("make-it-stronger scripts quote table and columns: %s", (name) => {
    const pg = removeScript("postgres", name, [name], ["id", name]).script.split("\n");
    expect(unquoted(pg[1])).toMatch(/^REVOKE SELECT ON Q(\.Q)* FROM zavi_reader;$/);
    expect(unquoted(pg[2])).toMatch(/^GRANT SELECT \(Q\) ON Q(\.Q)* TO zavi_reader;$/);
    const my = removeScript("mysql", "users", ["email"], ["id", name, "email"]).script.split("\n");
    expect(unquoted(my[2])).toBe("GRANT SELECT (Q, Q) ON Q TO 'zavi_reader'@'%';");
  });
});

describe("removeScript", () => {
  it("SQL keeps every other column", () => {
    expect(removeScript("postgres", "users", ["email"], ["id", "email", "plan"]).script).toContain('GRANT SELECT ("id", "plan") ON "users" TO zavi_reader;');
  });
  it("MongoDB and DynamoDB get no script at all (Zavi-side hiding only)", () => {
    expect(removeScript("mongodb", "users", ["email"], ["id", "email"]).script).toBe("");
    expect(removeScript("dynamodb", "users", ["email"], ["id", "email"]).script).toBe("");
  });
});

describe("tile", () => {
  it("states", () => {
    expect(dbTileState({ connected: false }, true)).toBe("none");
    expect(dbTileState(cloud, true)).toBe("cloud");
    expect(dbTileState({ ...cloud, legacy: true }, true)).toBe("legacy");
    expect(dbTileState({ ...cloud, mode: "connector" }, true)).toBe("connector");
    expect(dbTileState({ connected: false }, false)).toBe("member-none");
    expect(dbTileState(cloud, false)).toBe("member-connected");
  });
  it("menus: members get none", () => {
    expect(dbTileMenu("cloud")).toEqual(CLOUD_MENU);
    expect(dbTileMenu("legacy")).toEqual(CLOUD_MENU);
    expect(dbTileMenu("connector")).toEqual(CONNECTOR_MENU);
    expect(dbTileMenu("member-connected")).toEqual([]);
    expect(dbTileMenu("member-none")).toEqual([]);
  });
  it("descriptions", () => {
    expect(dbTileDescription("member-none", { connected: false })).toBe("Ask an owner or admin to connect your database");
    expect(dbTileDescription("cloud", cloud, "Last synced 2m ago")).toBe("Postgres · Last synced 2m ago");
  });
});

describe("visibilityBody", () => {
  const view = {
    tables: [
      { name: "users", rows: 1, view_of: null, enabled: true, columns: [] },
      { name: "audit", rows: 1, view_of: null, enabled: true, columns: [] },
      { name: "users_for_zavi", rows: 1, view_of: "users", enabled: false, columns: [] },
    ],
    sensitive: [
      { table: "users", field: "email", kind: "Email address", hidden: true },
      { table: "users", field: "phone", kind: "Phone number", hidden: true },
    ],
    hidden_fields: ["users.notes"],
    catalog_hash: "h1",
  };
  it("un-hide goes to unhidden_fields, off tables to disabled_tables, unlisted explicit hides are kept", () => {
    const body = visibilityBody(view, { "users.email": false, "users.phone": true }, { users: true, audit: false });
    expect(body).toEqual({
      catalog_hash: "h1",
      disabled_tables: ["audit"],
      hidden_fields: ["users.notes", "users.phone"],
      unhidden_fields: ["users.email"],
    });
  });
});
