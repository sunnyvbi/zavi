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
  dataRows: [] as Record<string, unknown>[],
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

import { listGeneratedAppTables, readGeneratedAppRows } from "@/services/website/app-data";

function column(name: string, over: Partial<ColumnRow> = {}): ColumnRow {
  return {
    table_name: "blog_posts",
    column_name: name,
    data_type: "text",
    udt_name: "text",
    is_nullable: "YES",
    column_default: null,
    is_identity: "NO",
    is_generated: "NEVER",
    primary_key: false,
    row_estimate: "10",
    enum_labels: null,
    ...over,
  };
}

const slugPk = column("slug", { is_nullable: "NO", primary_key: true });
const bodyCol = column("body");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.queries = [];
  mocks.query.mockImplementation((sql: string, params: unknown[]) => {
    mocks.queries.push({ sql, params });
    if (sql.includes("information_schema.columns")) return Promise.resolve({ rows: mocks.introspectRows });
    return Promise.resolve({ rows: mocks.dataRows, rowCount: mocks.dataRows.length });
  });
});

const read = () => readGeneratedAppRows({ tenantId: "t" as never, table: "blog_posts", limit: 25, offset: 0 });

describe("long values are reported as shortened, never silently editable", () => {
  it("flags a column whose value the transport cut", async () => {
    mocks.introspectRows = [slugPk, bodyCol];
    mocks.dataRows = [{ slug: "hello", body: "x".repeat(5000), __zavi_xmin: "1" }];

    const page = await read();

    expect(page.truncated_columns[0]).toContain("body");
    expect(String(page.rows[0].body)).toHaveLength(500);
    expect(String(page.rows[0].body).endsWith("…")).toBe(true);
  });

  it("does not flag a value that fits", async () => {
    mocks.introspectRows = [slugPk, bodyCol];
    mocks.dataRows = [{ slug: "hello", body: "short body", __zavi_xmin: "1" }];

    const page = await read();

    expect(page.truncated_columns[0]).toEqual([]);
    expect(page.rows[0].body).toBe("short body");
  });
});

describe("row keys are never shortened", () => {
  it("returns a long natural primary key in full, so update/delete still address the row", async () => {
    const longSlug = "s".repeat(5000);
    mocks.introspectRows = [slugPk, bodyCol];
    mocks.dataRows = [{ slug: longSlug, body: "b", __zavi_xmin: "1" }];

    const page = await read();

    expect(page.row_keys[0].slug).toBe(longSlug);
    expect(String(page.row_keys[0].slug)).toHaveLength(5000);
  });
});

describe("primary keys are de-duplicated", () => {
  it("keeps a repeated primary-key column from doubling the key", async () => {
    mocks.introspectRows = [slugPk, slugPk, bodyCol];
    mocks.dataRows = [];

    const [table] = await listGeneratedAppTables("t" as never);

    expect(table.primary_key).toEqual(["slug"]);
    expect(table.columns.filter((c) => c.name === "slug")).toHaveLength(1);
  });
});

describe("row_estimate", () => {
  it("reports an un-analyzed table as unknown rather than -1", async () => {
    mocks.introspectRows = [column("slug", { is_nullable: "NO", primary_key: true, row_estimate: "-1" })];
    mocks.dataRows = [];

    const [table] = await listGeneratedAppTables("t" as never);

    expect(table.row_estimate).toBeNull();
  });

  it("passes a real estimate through", async () => {
    mocks.introspectRows = [column("slug", { is_nullable: "NO", primary_key: true, row_estimate: "42" })];
    mocks.dataRows = [];

    const [table] = await listGeneratedAppTables("t" as never);

    expect(table.row_estimate).toBe(42);
  });

  it("asks Postgres to null out the -1 sentinel at the source", async () => {
    mocks.introspectRows = [slugPk];
    mocks.dataRows = [];
    await listGeneratedAppTables("t" as never);

    const introspect = mocks.queries.find((q) => q.sql.includes("information_schema.columns"));
    expect(introspect?.sql).toContain("NULLIF(cls.reltuples, -1)");
    expect(introspect?.sql).toContain("kcu.table_name = tc.table_name");
  });
});
