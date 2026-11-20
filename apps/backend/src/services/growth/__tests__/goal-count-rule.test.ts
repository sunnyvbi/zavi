import { describe, it, expect, vi } from "vitest";
import {
  oneNumber,
  parseCountRule,
  confirmedRule,
  ruleFromProposal,
  runCountRule,
  schemaHashFor,
  proposedCountRuleSchema,
  type CountDeps,
  type CountRule,
} from "../goal-count-rule";
import type { OperatorDbCatalog } from "@/services/tools/operator-db/types";

const T = "11111111-1111-4111-8111-111111111111";

const upcarCatalog: OperatorDbCatalog = {
  tables: [
    {
      name: "cars",
      rowEstimate: 3676,
      columns: [
        { name: "_id", type: "objectId", nullable: false },
        { name: "ownerId", type: "string", nullable: false },
        { name: "listingStatus", type: "string", nullable: true },
      ],
    },
    { name: "users", rowEstimate: 50000, columns: [{ name: "hostStatus", type: "bool", nullable: true }] },
  ],
};

export const UPCAR_HOSTS_RULE = {
  goal_id: "95c06147-0000-4000-8000-000000000000",
  definition: "hosts who ever listed a car, any listing status (distinct cars.ownerId)",
  dialect: "mongodb" as const,
  collection: "cars",
  pipeline: [{ $group: { _id: "$ownerId" } }, { $count: "n" }],
};

function deps(over: Partial<CountDeps> & { catalog?: CountDeps["catalog"] } = {}) {
  const calls: Array<{ fn: string; tenant: string }> = [];
  const d: CountDeps = {
    catalog: async (t) => (calls.push({ fn: "catalog", tenant: t }), { dialect: "mongodb", catalog: upcarCatalog, discovery_error: null }),
    mongoAggregate: async (t) => (calls.push({ fn: "mongo", tenant: t }), { rows: [{ n: 1522 }], truncated: false }),
    sqlRead: async (t) => (calls.push({ fn: "sql", tenant: t }), { rows: [{ count: "42" }], truncated: false }),
    ...over,
  };
  return { d, calls };
}

describe("oneNumber: exactly one numeric result", () => {
  it("accepts one row with one number, a whole-collection _id:null, and a Postgres count string", () => {
    expect(oneNumber([{ n: 1522 }], false)).toBe(1522);
    expect(oneNumber([{ _id: null, n: 7 }], false)).toBe(7);
    expect(oneNumber([{ count: "42" }], false)).toBe(42);
    expect(oneNumber([{ avg: 3.5 }], false)).toBe(3.5);
  });
  it("rejects no rows, many rows, many fields, text, and a truncated read", () => {
    expect(oneNumber([], false)).toBeNull();
    expect(oneNumber([{ n: 1 }, { n: 2 }], false)).toBeNull();
    expect(oneNumber([{ n: 1, m: 2 }], false)).toBeNull();
    expect(oneNumber([{ _id: "abc", n: 2 }], false)).toBeNull();
    expect(oneNumber([{ n: "many" }], false)).toBeNull();
    expect(oneNumber([{ n: 1 }], true)).toBeNull();
    expect(oneNumber([{ n: Number.NaN }], false)).toBeNull();
  });
});

describe("schemaHashFor", () => {
  const rule = ruleFromProposal(proposedCountRuleSchema.parse(UPCAR_HOSTS_RULE))!;
  it("ignores row counts and unrelated tables", () => {
    const h = schemaHashFor(upcarCatalog, rule);
    expect(h).toBeTruthy();
    const grown = { tables: [{ ...upcarCatalog.tables[0], rowEstimate: 9999 }, { name: "trips", rowEstimate: 1, columns: [] }] };
    expect(schemaHashFor(grown, rule)).toBe(h);
  });
  it("changes when a column the rule reads changes type or disappears", () => {
    const h = schemaHashFor(upcarCatalog, rule);
    const retyped = { tables: [{ ...upcarCatalog.tables[0], columns: [{ name: "ownerId", type: "objectId", nullable: false }] }] };
    expect(schemaHashFor(retyped, rule)).not.toBe(h);
    const dropped = { tables: [{ ...upcarCatalog.tables[0], columns: [] }] };
    expect(schemaHashFor(dropped, rule)).not.toBe(h);
  });
  it("is null when the rule reads a table the catalog does not know", () => {
    expect(schemaHashFor(upcarCatalog, { ...rule, collection: "hosts" })).toBeNull();
    expect(schemaHashFor(upcarCatalog, { dialect: "sql", query: "select count(*) from nowhere" })).toBeNull();
  });
});

describe("Upcar's hosts goal is expressible as a mongodb rule", () => {
  it("parses, dry-runs through the real read grammar, and counts 1,522", async () => {
    const proposal = proposedCountRuleSchema.parse(UPCAR_HOSTS_RULE);
    const rule = ruleFromProposal(proposal)!;
    expect(rule).toMatchObject({ dialect: "mongodb", source: "operator_db", collection: "cars" });
    const { d, calls } = deps();
    const out = await runCountRule(T, rule, { checkHash: false }, d);
    expect(out).toEqual({ ok: true, value: 1522, schema_hash: schemaHashFor(upcarCatalog, rule) });
    const stored = { ...rule, schema_hash: (out as { schema_hash: string }).schema_hash };
    expect(parseCountRule(stored)).toEqual(stored);
    expect(confirmedRule(stored)).toBeNull();
    expect(confirmedRule({ ...stored, confirmed_at: "2026-09-28T00:00:00Z" })).not.toBeNull();
    expect(calls.every((c) => c.tenant === T)).toBe(true);
  });
});

describe("runCountRule: read-only, tenant-bound, fail closed", () => {
  const mongoRule: CountRule = { ...ruleFromProposal(proposedCountRuleSchema.parse(UPCAR_HOSTS_RULE))!, schema_hash: schemaHashFor(upcarCatalog, ruleFromProposal(proposedCountRuleSchema.parse(UPCAR_HOSTS_RULE))!)! };

  it("never sends a SQL write to the database (the read-only guard rejects it first)", async () => {
    const { d, calls } = deps();
    for (const query of ["delete from users", "select 1; drop table users", "with x as (delete from users returning *) select count(*) from x", "update users set a=1"]) {
      expect(await runCountRule(T, { dialect: "sql", query }, { checkHash: false }, d)).toEqual({ ok: false, reason: "read_only_rejected" });
    }
    expect(calls).toEqual([]);
  });

  it("never runs a Mongo pipeline the read grammar rejects", async () => {
    const { d, calls } = deps();
    for (const pipeline of [[{ $out: "cars_copy" }], [{ $merge: { into: "x" } }], [{ $match: { $where: "1" } }]]) {
      const r = await runCountRule(T, { dialect: "mongodb", collection: "cars", pipeline }, { checkHash: false }, d);
      expect(r).toEqual({ ok: false, reason: "read_only_rejected" });
    }
    expect(calls.filter((c) => c.fn === "mongo")).toEqual([]);
  });

  it("a changed schema is not run when the hash is checked (daily rerun)", async () => {
    const retyped = { tables: [{ ...upcarCatalog.tables[0], columns: [{ name: "ownerId", type: "objectId", nullable: false }] }] };
    const { d, calls } = deps({ catalog: async () => ({ dialect: "mongodb", catalog: retyped, discovery_error: null }) });
    expect(await runCountRule(T, mongoRule, { checkHash: true }, d)).toEqual({ ok: false, reason: "schema_changed" });
    expect(calls.filter((c) => c.fn === "mongo")).toEqual([]);
  });

  it("rejects a non-numeric or multi-row result, an error, a missing DB and the wrong dialect", async () => {
    expect(await runCountRule(T, mongoRule, { checkHash: true }, deps({ mongoAggregate: async () => ({ rows: [{ n: 1 }, { n: 2 }], truncated: false }) }).d)).toEqual({ ok: false, reason: "not_one_number" });
    expect(await runCountRule(T, mongoRule, { checkHash: true }, deps({ mongoAggregate: async () => ({ rows: [{ name: "x" }], truncated: false }) }).d)).toEqual({ ok: false, reason: "not_one_number" });
    expect(await runCountRule(T, mongoRule, { checkHash: true }, deps({ mongoAggregate: async () => { throw new Error("boom"); } }).d)).toEqual({ ok: false, reason: "query_failed" });
    expect(await runCountRule(T, mongoRule, { checkHash: true }, deps({ catalog: async () => null }).d)).toEqual({ ok: false, reason: "not_connected" });
    expect(await runCountRule(T, { dialect: "sql", query: "select count(*) from cars" }, { checkHash: false }, deps().d)).toEqual({ ok: false, reason: "dialect_mismatch" });
  });

  it("SQL: a plain count runs through the tenant's reader and returns one number", async () => {
    const pgCatalog: OperatorDbCatalog = { tables: [{ name: "public.listings", rowEstimate: 10, columns: [{ name: "owner_id", type: "uuid", nullable: false }] }] };
    const sqlRead = vi.fn(async (_t: string, _q: string) => ({ rows: [{ count: "808" }], truncated: false }));
    const { d } = deps({ catalog: async () => ({ dialect: "postgres", catalog: pgCatalog, discovery_error: null }), sqlRead });
    const r = await runCountRule(T, { dialect: "sql", query: "select count(distinct owner_id) from listings" }, { checkHash: false }, d);
    expect(r).toMatchObject({ ok: true, value: 808 });
    expect(sqlRead).toHaveBeenCalledWith(T, "select count(distinct owner_id) from listings");
  });

  it("cross-tenant: a rule carries no connection or tenant; it runs only against the tenant passed in", async () => {
    const smuggled = { ...mongoRule, tenant_id: "22222222-2222-4222-8222-222222222222", connection_string: "mongodb://evil", confirmed_at: "2026-09-28T00:00:00Z" };
    const parsed = parseCountRule(smuggled)!;
    expect(parsed).not.toHaveProperty("tenant_id");
    expect(parsed).not.toHaveProperty("connection_string");
    const { d, calls } = deps();
    await runCountRule(T, parsed, { checkHash: true }, d);
    expect(calls.length).toBeGreaterThan(0);
    expect(new Set(calls.map((c) => c.tenant))).toEqual(new Set([T]));
  });

  it("a malformed rule is refused before any read", async () => {
    const { d, calls } = deps();
    expect(await runCountRule(T, { dialect: "sql" }, { checkHash: false }, d)).toEqual({ ok: false, reason: "invalid_rule" });
    expect(await runCountRule(T, { dialect: "mongodb", collection: "cars" }, { checkHash: false }, d)).toEqual({ ok: false, reason: "invalid_rule" });
    expect(calls).toEqual([]);
    expect(ruleFromProposal({ goal_id: UPCAR_HOSTS_RULE.goal_id, definition: "x x x", dialect: "sql" })).toBeNull();
  });
});
