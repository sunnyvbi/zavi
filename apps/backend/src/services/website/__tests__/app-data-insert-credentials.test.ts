import { beforeEach, describe, expect, it, vi } from "vitest";

type ColumnRow = {
  table_name: string;
  column_name: string;
  data_type: string;
  udt_name: string;
  is_nullable: "YES" | "NO";
  column_default: string | null;
  is_identity: "YES" | "NO";
  is_generated: "ALWAYS" | "NEVER";
  primary_key: boolean;
  row_estimate: string | null;
};

const mocks = vi.hoisted(() => ({
  introspectRows: [] as ColumnRow[],
  queries: [] as { sql: string; params: unknown[] }[],
  query: vi.fn(),
}));

vi.mock("pg", () => ({
  Client: class {
    connect() { return Promise.resolve(); }
    end() { return Promise.resolve(); }
    query(sql: string, params: unknown[] = []) { return mocks.query(sql, params); }
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

import { AppDataError, createGeneratedAppRow } from "@/services/website/app-data";

function column(name: string, over: Partial<ColumnRow> = {}): ColumnRow {
  return {
    table_name: "users",
    column_name: name,
    data_type: "text",
    udt_name: "text",
    is_nullable: "YES",
    column_default: null,
    is_identity: "NO",
    is_generated: "NEVER",
    primary_key: false,
    row_estimate: "1",
    ...over,
  };
}

const idColumn = column("id", { data_type: "bigint", udt_name: "int8", is_nullable: "NO", is_identity: "YES", primary_key: true });
const emailColumn = column("email", { is_nullable: "NO" });

function setSchema(columns: ColumnRow[]) {
  mocks.introspectRows = columns;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.queries = [];
  mocks.query.mockImplementation((sql: string, params: unknown[]) => {
    mocks.queries.push({ sql, params });
    if (sql.includes("information_schema.columns")) return Promise.resolve({ rows: mocks.introspectRows });
    return Promise.resolve({ rows: [{ id: 1, email: "a@b.co", __zavi_xmin: "42" }], rowCount: 1 });
  });
});

const insert = () => mocks.queries.find((q) => q.sql.startsWith("INSERT"));

describe("createGeneratedAppRow credential handling", () => {
  it("blocks inserts into tables with a NOT NULL protected credential column, writing no credential", async () => {
    setSchema([idColumn, emailColumn, column("password_hash", { is_nullable: "NO" })]);
    const error = await createGeneratedAppRow({
      tenantId: "tenant-a" as never,
      table: "users",
      values: { email: "a@b.co" },
    }).catch((e) => e);

    expect(error).toBeInstanceOf(AppDataError);
    expect((error as AppDataError).code).toBe("app_db_credential_required");
    expect((error as AppDataError).message).toMatch(/password_hash/);
    expect((error as AppDataError).message).toMatch(/signup flow/i);
    expect(insert()).toBeUndefined();
  });

  it("blocks a Supabase-convention encrypted_password column the same way", async () => {
    setSchema([idColumn, emailColumn, column("encrypted_password", { is_nullable: "NO" })]);
    const error = await createGeneratedAppRow({
      tenantId: "tenant-a" as never,
      table: "users",
      values: { email: "a@b.co" },
    }).catch((e) => e);

    expect((error as AppDataError).code).toBe("app_db_credential_required");
    expect(insert()).toBeUndefined();
  });

  it("inserts unchanged when the table has no credential column", async () => {
    setSchema([idColumn, emailColumn, column("name")]);
    const row = await createGeneratedAppRow({
      tenantId: "tenant-a" as never,
      table: "users",
      values: { email: "a@b.co" },
    });

    expect(row.values).toMatchObject({ email: "a@b.co" });
    const stmt = insert();
    expect(stmt?.sql).toContain('INSERT INTO "public"."users" ("email")');
    expect(stmt?.params).toEqual(["a@b.co"]);
  });

  it("does not block when the credential column is nullable", async () => {
    setSchema([idColumn, emailColumn, column("password_hash", { is_nullable: "YES" })]);
    await createGeneratedAppRow({ tenantId: "tenant-a" as never, table: "users", values: { email: "a@b.co" } });

    const stmt = insert();
    expect(stmt?.sql).toContain("INSERT INTO");
    expect(stmt?.params).toEqual(["a@b.co"]);
    expect(stmt?.sql).not.toContain("password_hash");
  });

  it("does not block when the credential column has a default", async () => {
    setSchema([idColumn, emailColumn, column("password_hash", { is_nullable: "NO", column_default: "''::text" })]);
    await createGeneratedAppRow({ tenantId: "tenant-a" as never, table: "users", values: { email: "a@b.co" } });

    expect(insert()?.sql).toContain("INSERT INTO");
    expect(insert()?.sql).not.toContain("password_hash");
  });
});
