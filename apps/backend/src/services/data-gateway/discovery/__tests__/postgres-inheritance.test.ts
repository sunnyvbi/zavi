import { describe, it, expect, vi } from "vitest";

const m = vi.hoisted(() => ({
  tables: [] as { table_name: string; est: string | null }[],
  ancestors: [] as { child: string; parents: string[] }[],
}));

vi.mock("pg", () => ({
  Client: class {
    async connect() {}
    async end() {}
    async query(sql: string, params?: unknown[]) {
      if (/FROM information_schema\.tables/.test(sql)) return { rows: m.tables };
      if (/WITH RECURSIVE anc/.test(sql)) return { rows: m.ancestors };
      if (/WITH RECURSIVE tree/.test(sql)) return { rows: [] };
      if (/FROM information_schema\.columns/.test(sql)) {
        const names = (params?.[0] as string[]) ?? [];
        return { rows: names.map((n) => ({ table_name: n, column_name: "id", data_type: "integer", is_nullable: "NO" })) };
      }
      return { rows: [] };
    }
  },
}));

import { introspectPostgres } from "../postgres";
import { effectivePolicy } from "@zavi/shared/db-guard";
import { normalizeRawCatalog } from "@/services/tools/operator-db/discovery";

describe("introspectPostgres inheritance", () => {
  it("a big partition whose small parent falls past the cap brings the parent along and records it", async () => {
    m.tables = [
      { table_name: "zz_parent", est: "0" },
      { table_name: "big_part", est: "1000000" },
      { table_name: "mid", est: "5000" },
    ];
    m.ancestors = [{ child: "big_part", parents: ["zz_parent"] }];
    const raw = await introspectPostgres("postgres://u:p@h/db", 2, Date.now() + 5000);
    expect(raw.tables.map((t) => t.name)).toEqual(["zz_parent", "big_part"]);
    expect(raw.tables.find((t) => t.name === "big_part")?.parents).toEqual(["zz_parent"]);
    expect(raw.namesSeenTotal).toBe(3);
    expect(raw.listingTruncated).toBe(false);
  });
  it("a child whose parent is outside public is left out of the catalog", async () => {
    m.tables = [
      { table_name: "kids", est: "10" },
      { table_name: "plans", est: "1" },
    ];
    m.ancestors = [{ child: "kids", parents: ["audit.base"] }];
    const raw = await introspectPostgres("postgres://u:p@h/db", 10, Date.now() + 5000);
    expect(raw.tables.map((t) => t.name)).toEqual(["plans"]);
  });
  it("the persisted catalog carries parents, and a disabled INHERITS parent refuses the child", async () => {
    m.tables = [
      { table_name: "people", est: "10" },
      { table_name: "staff", est: "5" },
    ];
    m.ancestors = [{ child: "staff", parents: ["people"] }];
    const catalog = normalizeRawCatalog(await introspectPostgres("postgres://u:p@h/db", 10, Date.now() + 5000));
    expect(catalog.tables.find((t) => t.name === "staff")?.parents).toEqual(["people"]);
    expect(catalog.tables.find((t) => t.name === "people")).not.toHaveProperty("parents");
    const p = effectivePolicy({ auto_hide: false, hidden_fields: [], unhidden_fields: [], disabled_tables: ["people"] }, catalog, "postgres");
    expect(p.isAllowed("staff")).toBe(false);
  });
});
