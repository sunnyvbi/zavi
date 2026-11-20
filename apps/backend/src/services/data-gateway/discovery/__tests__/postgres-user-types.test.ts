import { describe, it, expect, vi } from "vitest";

const m = vi.hoisted(() => ({ sqls: [] as string[] }));

vi.mock("pg", () => ({
  Client: class {
    async connect() {}
    async end() {}
    async query(sql: string, params?: unknown[]) {
      m.sqls.push(sql);
      if (/FROM information_schema\.tables/.test(sql)) return { rows: [{ table_name: "profiles", est: "100" }] };
      if (/FROM information_schema\.columns/.test(sql)) {
        const col = (column_name: string, data_type: string, udt_name: string, typtype: string | null) => ({
          table_name: "profiles", column_name, data_type, is_nullable: "YES", udt_name, typtype, type_schema: "public", type_citext_ext: udt_name === "citext",
        });
        return {
          rows: [
            col("id", "integer", "int4", "b"),
            col("attrs", "USER-DEFINED", "hstore", "b"),
            col("city", "USER-DEFINED", "citext", "b"),
            col("status", "USER-DEFINED", "profile_status", "e"),
            col("who", "USER-DEFINED", "person_t", "c"),
            col("shape", "USER-DEFINED", "geometry", "b"),
          ].filter(() => (params?.[0] as string[]).includes("profiles")),
        };
      }
      if (/p\.proname = 'skeys'/.test(sql)) return { rows: [{ schema: "extensions", type_schema: "public" }] };
      if (/count\(\*\)::int AS n/.test(sql)) return { rows: [{ n: 50 }] };
      if (/skeys\(s\.h\)/.test(sql)) return { rows: [{ k: "email" }, { k: "plan" }] };
      if (/FROM pg_type t\s+JOIN pg_namespace n/.test(sql)) {
        expect(params?.[0]).toEqual(["public.person_t"]);
        return {
          rows: ["label", "ssn"].map((attname) => ({
            type_schema: "public", type_name: "person_t", attname, att_typtype: "b", att_typname: "text", att_schema: "pg_catalog",
          })),
        };
      }
      return { rows: [] };
    }
  },
}));

import { introspectPostgres } from "../postgres";
import { effectivePolicy } from "@zavi/shared/db-guard";
import { normalizeRawCatalog } from "@/services/tools/operator-db/discovery";

describe("introspectPostgres USER-DEFINED columns", () => {
  it("records real types, samples hstore keys and composite attributes, and hides them by default", async () => {
    const catalog = normalizeRawCatalog(await introspectPostgres("postgres://u:p@h/db", 10, Date.now() + 5000));
    const cols = new Map(catalog.tables[0]!.columns.map((c) => [c.name, c]));
    expect(cols.get("attrs")).toMatchObject({ type: "hstore", json_sampled: "full", json_keys: ["email", "plan"] });
    expect(cols.get("city")?.type).toBe("citext");
    expect(cols.get("status")?.type).toBe("enum (profile_status)");
    expect(cols.get("who")).toMatchObject({ type: "composite (person_t)", json_sampled: "full", json_keys: ["label", "ssn"] });
    expect(cols.get("shape")?.type).toBe("USER-DEFINED (geometry)");
    expect(m.sqls.some((s) => /"extensions"\.skeys\(s\.h\)/.test(s))).toBe(true);
    const p = effectivePolicy({ auto_hide: true, hidden_fields: [], unhidden_fields: [], disabled_tables: [] }, catalog, "postgres");
    expect(p.hiddenFields("profiles").sort()).toEqual(["attrs", "shape", "who"]);
    expect(p.visibleColumns("profiles")).toEqual(["id", "city", "status"]);
  });
});
