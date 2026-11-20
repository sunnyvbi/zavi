import { beforeEach, describe, expect, it, vi } from "vitest";

type Q = { sql: string; params: unknown[] };
const mocks = vi.hoisted(() => ({ queries: [] as Q[], query: vi.fn() }));

vi.mock("pg", () => ({
  Client: class {
    connect() { return Promise.resolve(); }
    end() { return Promise.resolve(); }
    query(sql: string, params: unknown[] = []) {
      mocks.queries.push({ sql, params });
      return mocks.query(sql, params);
    }
  },
}));
vi.mock("@/services/secrets/vault", () => ({ getSecret: vi.fn().mockResolvedValue("postgres://app") }));
vi.mock("@/services/tenant-client", () => ({
  tenantClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({
            data: { mode: "provisioned", status: "ready", provider: "neon", vault_key: "k" },
            error: null,
          }),
        }),
      }),
    }),
  }),
}));

import {
  AppDataError,
  createGeneratedAppRow,
  deleteGeneratedAppRow,
  listGeneratedAppTables,
  readGeneratedAppRows,
  updateGeneratedAppRow,
} from "@/services/website/app-data";

function col(table: string, name: string, over: Record<string, unknown> = {}) {
  return {
    table_name: table,
    column_name: name,
    data_type: "text",
    udt_name: "text",
    is_nullable: "YES",
    column_default: null,
    is_identity: "NO",
    is_generated: "NEVER",
    primary_key: false,
    row_estimate: "1",
    enum_labels: null,
    ...over,
  };
}
const pk = (table: string) =>
  col(table, "id", { data_type: "bigint", udt_name: "int8", is_nullable: "NO", primary_key: true, column_default: "nextval('x')" });

const INTROSPECT = [
  pk("users"),
  col("users", "email"),
  col("users", "password_hash"),
  col("users", "role", { data_type: "USER-DEFINED", udt_name: "app_role", is_nullable: "NO", column_default: "'user'::app_role", enum_labels: ["user", "admin"] }),
  pk("invites"),
  col("invites", "token_hash"),
  col("invites", "role"),
  pk("_zavi_audit"),
  col("_zavi_audit", "event"),
  pk("orders"),
  col("orders", "title"),
];

let auditExists = true;
let oldRole = "user";

beforeEach(() => {
  mocks.queries.length = 0;
  auditExists = true;
  oldRole = "user";
  mocks.query.mockImplementation(async (sql: string, params: unknown[]) => {
    if (sql.includes("information_schema.columns c")) return { rows: INTROSPECT };
    if (sql.includes("to_regclass('public._zavi_audit')")) return { rows: [{ ok: auditExists }] };
    if (sql.startsWith("UPDATE")) {
      const values = sql.includes("__zavi_old_role")
        ? { id: "7", email: "a@b.c", role: params[0], __zavi_xmin: "9", __zavi_old_role: oldRole }
        : { id: "7", title: params[0], __zavi_xmin: "9" };
      return { rowCount: 1, rows: [values] };
    }
    return { rowCount: 1, rows: [] };
  });
});

describe("hidden site-internal tables", () => {
  it("the catalog never lists invites or _zavi_audit (and the SQL excludes them)", async () => {
    const tables = await listGeneratedAppTables("t" as never);
    expect(tables.map((t) => t.name).sort()).toEqual(["orders", "users"]);
    const introspect = mocks.queries.find((q) => q.sql.includes("information_schema.columns c"))!;
    expect(introspect.sql).toMatch(/NOT IN \('_schema_meta', '_schema_migrations', 'invites', '_zavi_audit'\)/);
  });

  for (const table of ["invites", "_zavi_audit"]) {
    it(`every app-rows op on ${table} is refused as an unknown table, with no row SQL run`, async () => {
      const ops = [
        () => readGeneratedAppRows({ tenantId: "t" as never, table, limit: 10, offset: 0 }),
        () => createGeneratedAppRow({ tenantId: "t" as never, table, values: { role: "admin" } }),
        () => updateGeneratedAppRow({ tenantId: "t" as never, table, key: { id: 1 }, version: "1", values: { role: "admin" } }),
        () => deleteGeneratedAppRow({ tenantId: "t" as never, table, key: { id: 1 }, version: "1" }),
      ];
      for (const op of ops) {
        await expect(op()).rejects.toMatchObject({ code: "app_db_bad_table" });
      }
      expect(mocks.queries.every((q) => q.sql.includes("information_schema.columns c"))).toBe(true);
    });
  }
});

describe("users.role change audit", () => {
  it("reads the old role in the SAME UPDATE (locked sub-select) and reports from/to", async () => {
    const out = await updateGeneratedAppRow({
      tenantId: "t" as never, table: "users", key: { id: 7 }, version: "9", values: { role: "admin" },
    });
    expect(out.roleChange).toEqual({ table: "users", target_id: "7", from: "user", to: "admin" });
    expect(out.values).toMatchObject({ role: "admin" });
    expect(Object.keys(out.values)).not.toContain("__zavi_old_role");
    const sqls = mocks.queries.map((q) => q.sql);
    const upd = mocks.queries.find((q) => q.sql.startsWith("UPDATE"))!;
    expect(upd.sql).toMatch(/UPDATE "public"\."users" AS t SET "role" = \$1 FROM \(SELECT ctid AS __zavi_ctid, "role"::text AS __zavi_old_role FROM "public"\."users" WHERE "id" IS NOT DISTINCT FROM \$2 FOR UPDATE\) AS o WHERE t\.ctid = o\.__zavi_ctid AND t\.xmin::text = \$3 RETURNING/);
    expect(upd.params).toEqual(["admin", 7, "9"]);
    expect(sqls.indexOf("BEGIN")).toBeLessThan(sqls.indexOf(upd.sql));
    const audit = mocks.queries.find((q) => q.sql.startsWith("INSERT INTO public._zavi_audit"))!;
    expect(audit.params).toEqual(["app_role_changed", "7", JSON.stringify({ table: "users", from: "user", to: "admin" })]);
    expect(sqls.indexOf(audit.sql)).toBeLessThan(sqls.indexOf("COMMIT"));
    expect(String(audit.params[2])).not.toContain("a@b.c");
  });

  it("no roleChange and no audit row when the role did not actually change", async () => {
    oldRole = "admin";
    const out = await updateGeneratedAppRow({
      tenantId: "t" as never, table: "users", key: { id: 7 }, version: "9", values: { role: "admin" },
    });
    expect(out.roleChange).toBeNull();
    expect(mocks.queries.some((q) => q.sql.startsWith("INSERT INTO public._zavi_audit"))).toBe(false);
  });

  it("skips the site audit row when _zavi_audit does not exist, still commits the change", async () => {
    auditExists = false;
    const out = await updateGeneratedAppRow({
      tenantId: "t" as never, table: "users", key: { id: 7 }, version: "9", values: { role: "admin" },
    });
    expect(out.roleChange).not.toBeNull();
    expect(mocks.queries.some((q) => q.sql.startsWith("INSERT INTO public._zavi_audit"))).toBe(false);
    expect(mocks.queries.map((q) => q.sql)).toContain("COMMIT");
  });

  it("a stale version rolls back and reports app_db_stale_row", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("information_schema.columns c")) return { rows: INTROSPECT };
      if (sql.startsWith("UPDATE")) return { rowCount: 0, rows: [] };
      return { rowCount: 0, rows: [] };
    });
    await expect(updateGeneratedAppRow({
      tenantId: "t" as never, table: "users", key: { id: 7 }, version: "1", values: { role: "admin" },
    })).rejects.toBeInstanceOf(AppDataError);
    expect(mocks.queries.map((q) => q.sql)).toContain("ROLLBACK");
  });

  it("a PATCH that does not touch role keeps the plain UPDATE and reports no role change", async () => {
    const out = await updateGeneratedAppRow({
      tenantId: "t" as never, table: "orders", key: { id: 7 }, version: "9", values: { title: "x" },
    });
    expect(out.roleChange).toBeNull();
    const upd = mocks.queries.find((q) => q.sql.startsWith("UPDATE"))!;
    expect(upd.sql).not.toMatch(/__zavi_old_role|FOR UPDATE/);
    expect(mocks.queries.map((q) => q.sql)).not.toContain("BEGIN");
  });
});
