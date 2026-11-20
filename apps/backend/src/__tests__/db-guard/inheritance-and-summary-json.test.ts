import { describe, it, expect } from "vitest";
import {
  capWithAncestors,
  checkSummary,
  compileSummary,
  effectivePolicy,
  guardSql,
  policyFromRules,
  SummaryRequest,
  MAX_PARENTS,
  type CatalogLike,
  type PolicyRow,
} from "@zavi/shared/db-guard";

const base: PolicyRow = { auto_hide: false, hidden_fields: [], unhidden_fields: [], disabled_tables: [] };
const cols = [{ name: "id" }, { name: "internal_note" }, { name: "total" }];
const reason = (r: ReturnType<typeof guardSql>) => (r.ok ? "" : r.reason);
const pg = (sql: string, policy: ReturnType<typeof effectivePolicy>) => guardSql(sql, { policy, dialect: "postgres" });

describe("discovery cap keeps a child only with all its ancestors", () => {
  const ancestors = new Map([
    ["orders_2024", ["orders"]],
    ["orders_2024_q1", ["orders", "orders_2024"]],
    ["staff", ["people"]],
    ["ext_child", ["other_schema.base"]],
  ]);
  const listed = new Set(["orders_2024_q1", "orders_2024", "ext_child", "staff", "plans", "orders", "people"]);
  it("pulls in a parent the cap would have left out, ancestors before the child", () => {
    const out = capWithAncestors(["orders_2024", "plans", "orders"], 2, ancestors, listed);
    expect(out).toEqual(["orders", "orders_2024"]);
  });
  it("pulls in every level for a sub-partition", () => {
    const out = capWithAncestors(["orders_2024_q1", "plans"], 10, ancestors, listed);
    expect(out.indexOf("orders")).toBeLessThan(out.indexOf("orders_2024"));
    expect(out.indexOf("orders_2024")).toBeLessThan(out.indexOf("orders_2024_q1"));
    expect(out).toContain("plans");
  });
  it("drops a child whose ancestor is outside public / not listed, or whose ancestors do not fit", () => {
    expect(capWithAncestors(["ext_child", "plans"], 10, ancestors, listed)).toEqual(["plans"]);
    expect(capWithAncestors(["plans", "orders_2024_q1", "staff"], 3, ancestors, listed)).toEqual(["plans", "people", "staff"]);
  });
  it("never exceeds the cap", () => {
    expect(capWithAncestors(["orders_2024_q1", "orders_2024", "staff", "plans"], 2, ancestors, listed).length).toBeLessThanOrEqual(2);
  });
  it("drops a child with more than MAX_PARENTS ancestors", () => {
    const deep = Array.from({ length: MAX_PARENTS + 1 }, (_, i) => `p${i}`);
    expect(capWithAncestors(["deep"], 100, new Map([["deep", deep]]), new Set(["deep", ...deep]))).toEqual([]);
  });
  it("plain tables are capped in rank order as before", () => {
    expect(capWithAncestors(["a", "b", "c"], 2, new Map(), new Set(["a", "b", "c"]))).toEqual(["a", "b"]);
  });
});

describe("children without a known parent fail closed (must-catch)", () => {
  it("a partition whose parent is not in the catalog is refused", () => {
    const cat: CatalogLike = { tables: [{ name: "orders_2024", columns: cols, parents: ["orders"] }, { name: "plans", columns: [{ name: "id" }] }] };
    const p = effectivePolicy(base, cat, "postgres");
    expect(p.isAllowed("orders_2024")).toBe(false);
    expect(pg("SELECT * FROM orders_2024", p).ok).toBe(false);
    expect(p.isAllowed("plans")).toBe(true);
  });
  it("a child whose ancestor lives outside public is refused", () => {
    const cat: CatalogLike = { tables: [{ name: "kids", columns: cols, parents: ["audit.base"] }] };
    expect(effectivePolicy(base, cat, "postgres").isAllowed("kids")).toBe(false);
  });
  it("a sub-partition whose top-level parent is switched off is refused", () => {
    const cat: CatalogLike = {
      tables: [
        { name: "orders", columns: cols, partitioned: true, partitions: ["orders_2024", "orders_2024_q1"] },
        { name: "orders_2024", columns: cols, parents: ["orders"], partitioned: true, partitions: ["orders_2024_q1"] },
        { name: "orders_2024_q1", columns: cols, parents: ["orders", "orders_2024"] },
      ],
    };
    const p = effectivePolicy({ ...base, disabled_tables: ["orders"] }, cat, "postgres");
    expect(p.isAllowed("orders_2024")).toBe(false);
    expect(p.isAllowed("orders_2024_q1")).toBe(false);
  });
});

describe("classic INHERITS children inherit their parent (must-catch)", () => {
  const cat: CatalogLike = {
    tables: [
      { name: "people", columns: [{ name: "id" }, { name: "salary" }, { name: "city" }] },
      { name: "staff", columns: [{ name: "id" }, { name: "salary" }, { name: "city" }, { name: "team" }], parents: ["people"] },
    ],
  };
  it("parent switched off: the child is refused", () => {
    const p = effectivePolicy({ ...base, disabled_tables: ["people"] }, cat, "postgres");
    expect(p.isAllowed("staff")).toBe(false);
    expect(pg("SELECT team FROM staff", p).ok).toBe(false);
  });
  it("a field hidden on the parent is hidden on the child: SELECT * drops it, naming it is refused", () => {
    const p = effectivePolicy({ ...base, hidden_fields: ["people.salary"] }, cat, "postgres");
    expect(p.isHidden("staff", "salary")).toBe(true);
    const star = pg("SELECT * FROM staff", p);
    expect(star.ok && star.sql).toBe('SELECT * FROM (SELECT "id", "city", "team" FROM ONLY "public"."staff") AS "staff"');
    expect(reason(pg("SELECT salary FROM staff", p))).toMatch(/hidden/);
  });
  it("connector rules: child allowed but parent not in the allow-list stays denied; blocked fields copy down", () => {
    const rules = (allowed: string[], blocked: string[] = []) =>
      policyFromRules({ allowed, blocked, what_can_leave: "rows_without_blocked_columns", max_rows: 100 }, cat, "postgres");
    expect(rules(["staff"]).isAllowed("staff")).toBe(false);
    expect(rules(["people", "staff"], ["people.salary"]).isHidden("staff", "salary")).toBe(true);
  });
});

describe("inheritance (must-not-catch)", () => {
  it("a partitioned table fully in the catalog stays readable, parent and partitions", () => {
    const cat: CatalogLike = {
      tables: [
        { name: "orders", columns: cols, partitioned: true, partitions: ["orders_2024", "orders_2025"] },
        { name: "orders_2024", columns: cols, parents: ["orders"] },
        { name: "orders_2025", columns: cols, parents: ["orders"] },
      ],
    };
    const p = effectivePolicy(base, cat, "postgres");
    expect(pg("SELECT id, internal_note FROM orders_2024", p).ok).toBe(true);
    expect(pg("SELECT count(*) FROM orders", p).ok).toBe(true);
  });
  it("an INHERITS child of an allowed, hide-free parent reads as before", () => {
    const cat: CatalogLike = { tables: [{ name: "people", columns: [{ name: "id" }] }, { name: "staff", columns: [{ name: "id" }, { name: "team" }], parents: ["people"] }] };
    expect(pg("SELECT id, team FROM staff", effectivePolicy(base, cat, "postgres")).ok).toBe(true);
  });
});

describe("summaries refuse JSON / structured fields (must-catch)", () => {
  const cat: CatalogLike = {
    tables: [
      {
        name: "events",
        columns: [
          { name: "id", type: "integer" },
          { name: "city", type: "text" },
          { name: "payload", type: "jsonb", json_keys: ["plan"], json_sampled: "full" },
          { name: "meta", type: "json" },
          { name: "tags", type: "ARRAY" },
          { name: "amount", type: "numeric" },
        ],
      },
    ],
  };
  const pgPolicy = effectivePolicy(base, cat, "postgres");
  const req = (r: unknown) => SummaryRequest.parse(r);
  it("group by a visible jsonb column is refused", () => {
    const r = compileSummary(req({ table: "events", measures: [{ fn: "count" }], group_by: [{ field: "payload" }] }), "postgres", pgPolicy);
    expect(r).toMatchObject({ ok: false });
    expect("reason" in r && r.reason).toMatch(/JSON or other structured/);
  });
  it("group by a json column with no sampled keys, and by an array, are refused", () => {
    expect(checkSummary(req({ table: "events", measures: [{ fn: "count" }], group_by: [{ field: "meta" }] }), pgPolicy)).toMatchObject({ ok: false });
    expect(checkSummary(req({ table: "events", measures: [{ fn: "count" }], group_by: [{ field: "tags" }] }), pgPolicy)).toMatchObject({ ok: false });
  });
  it("a filter or a measure on a JSON column is refused", () => {
    expect(checkSummary(req({ table: "events", measures: [{ fn: "count" }], filters: [{ field: "payload", op: "is_null" }] }), pgPolicy)).toMatchObject({ ok: false });
    expect(checkSummary(req({ table: "events", measures: [{ fn: "max", field: "meta" }] }), pgPolicy)).toMatchObject({ ok: false });
  });
  it("MySQL JSON and Mongo sub-documents are refused too", () => {
    const my = effectivePolicy(base, { tables: [{ name: "events", columns: [{ name: "doc", type: "json" }] }] }, "mysql");
    expect(checkSummary(req({ table: "events", measures: [{ fn: "count" }], group_by: [{ field: "doc" }] }), my)).toMatchObject({ ok: false });
    const mo = effectivePolicy(base, { tables: [{ name: "events", columns: [{ name: "profile", type: "Document|Null" }, { name: "items", type: "Array" }] }] }, "mongodb");
    expect(checkSummary(req({ table: "events", measures: [{ fn: "count" }], group_by: [{ field: "profile" }] }), mo)).toMatchObject({ ok: false });
    expect(checkSummary(req({ table: "events", measures: [{ fn: "count" }], group_by: [{ field: "items" }] }), mo)).toMatchObject({ ok: false });
  });
  it("must-not-catch: a summary by city with a sum still compiles", () => {
    const r = compileSummary(req({ table: "events", measures: [{ fn: "count" }, { fn: "sum", field: "amount" }], group_by: [{ field: "city" }] }), "postgres", pgPolicy);
    expect("ok" in r).toBe(false);
  });
});
