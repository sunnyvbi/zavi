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
  enum_labels: string[] | null;
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

import {
  AppDataError,
  createGeneratedAppRow,
  listGeneratedAppTables,
  updateGeneratedAppRow,
} from "@/services/website/app-data";

function column(name: string, over: Partial<ColumnRow> = {}): ColumnRow {
  return {
    table_name: "orders",
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

const titleColumn = column("title");

const serialPk = column("id", {
  data_type: "integer", udt_name: "int4", is_nullable: "NO", primary_key: true,
  column_default: "nextval('orders_id_seq'::regclass)",
});
const identityPk = column("id", {
  data_type: "bigint", udt_name: "int8", is_nullable: "NO", primary_key: true, is_identity: "YES",
});
const uuidDefaultPk = column("id", {
  data_type: "uuid", udt_name: "uuid", is_nullable: "NO", primary_key: true,
  column_default: "gen_random_uuid()",
});
const naturalPk = column("slug", { is_nullable: "NO", primary_key: true });

function setSchema(columns: ColumnRow[]) {
  mocks.introspectRows = columns;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.queries = [];
  mocks.query.mockImplementation((sql: string, params: unknown[]) => {
    mocks.queries.push({ sql, params });
    if (sql.includes("information_schema.columns")) return Promise.resolve({ rows: mocks.introspectRows });
    return Promise.resolve({ rows: [{ slug: "a", title: "t", __zavi_xmin: "42" }], rowCount: 1 });
  });
});

const insert = () => mocks.queries.find((q) => q.sql.startsWith("INSERT"));
const update = () => mocks.queries.find((q) => q.sql.startsWith("UPDATE"));

const createWithId = (values: Record<string, unknown>) =>
  createGeneratedAppRow({ tenantId: "tenant-a" as never, table: "orders", values }).catch((e) => e);

describe("primary keys the database assigns are not settable on INSERT", () => {
  it.each([
    ["serial", serialPk],
    ["uuid with gen_random_uuid() default", uuidDefaultPk],
  ])("rejects a %s primary key and writes nothing", async (_label, pk) => {
    setSchema([pk, titleColumn]);
    const error = await createWithId({ id: "999", title: "t" });

    expect(error).toBeInstanceOf(AppDataError);
    expect((error as AppDataError).code).toBe("app_db_protected_column");
    expect((error as AppDataError).message).toMatch(/assigned by the database/i);
    expect(insert()).toBeUndefined();
  });

  it("rejects an identity primary key (caught by the writable gate, before the PK rules)", async () => {
    setSchema([identityPk, titleColumn]);
    const error = await createWithId({ id: 999, title: "t" });

    expect((error as AppDataError).code).toBe("app_db_protected_column");
    expect(insert()).toBeUndefined();
  });

  it("still inserts normally when the auto-assigned id is simply omitted", async () => {
    setSchema([serialPk, titleColumn]);
    await createGeneratedAppRow({ tenantId: "tenant-a" as never, table: "orders", values: { title: "t" } });

    const stmt = insert();
    expect(stmt?.sql).toContain('INSERT INTO "public"."orders" ("title")');
    expect(stmt?.sql.split("VALUES")[0]).not.toContain('"id"');
    expect(stmt?.params).toEqual(["t"]);
  });
});

describe("a natural primary key stays settable on INSERT", () => {
  it("accepts a text primary key that has no default", async () => {
    setSchema([naturalPk, titleColumn]);
    const row = await createGeneratedAppRow({
      tenantId: "tenant-a" as never,
      table: "orders",
      values: { slug: "my-order", title: "t" },
    });

    expect(row.values).toMatchObject({ slug: "a" });
    const stmt = insert();
    expect(stmt?.sql).toContain('INSERT INTO "public"."orders"');
    expect(stmt?.sql).toContain('"slug"');
    expect(stmt?.params).toEqual(["my-order", "t"]);
  });
});

describe("no primary key is editable on UPDATE", () => {
  it.each([
    ["natural", naturalPk, "slug"],
    ["serial", serialPk, "id"],
  ])("rejects editing a %s primary key", async (_label, pk, name) => {
    setSchema([pk, titleColumn]);
    const error = await updateGeneratedAppRow({
      tenantId: "tenant-a" as never,
      table: "orders",
      key: { [name]: "a" },
      version: "42",
      values: { [name]: "changed" },
    }).catch((e) => e);

    expect(error).toBeInstanceOf(AppDataError);
    expect((error as AppDataError).code).toBe("app_db_protected_column");
    expect(update()).toBeUndefined();
  });
});

describe("enum introspection", () => {
  it("exposes enum labels in declaration order for a public column", async () => {
    setSchema([
      naturalPk,
      column("status", { data_type: "USER-DEFINED", udt_name: "order_status", enum_labels: ["pending", "paid", "refunded"] }),
    ]);
    const [table] = await listGeneratedAppTables("tenant-a" as never);
    const status = table.columns.find((c) => c.name === "status");

    expect(status?.type).toBe("order_status");
    expect(status?.enum_values).toEqual(["pending", "paid", "refunded"]);
  });

  it("returns null enum_values for an ordinary column", async () => {
    setSchema([naturalPk, titleColumn]);
    const [table] = await listGeneratedAppTables("tenant-a" as never);

    expect(table.columns.find((c) => c.name === "title")?.enum_values).toBeNull();
  });

  it("never leaks a protected column's enum labels — the column itself is dropped", async () => {
    setSchema([
      naturalPk,
      column("password_reset_token", { data_type: "USER-DEFINED", udt_name: "token_kind", enum_labels: ["short", "long"] }),
    ]);
    const [table] = await listGeneratedAppTables("tenant-a" as never);

    expect(table.columns.map((c) => c.name)).not.toContain("password_reset_token");
    expect(JSON.stringify(table)).not.toContain("short");
  });
});
