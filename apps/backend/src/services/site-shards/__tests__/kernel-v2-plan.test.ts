import { describe, expect, it } from "vitest";
import { planSite, sitePlanIsEmpty } from "../collections-plan";
import { EMPTY_SITE_CONTRACT, type CollectionDef, type SiteContractDef } from "../contract";
import { applySitePlanSql, refusalFromError } from "../apply-v2";
import { collectionsOf, siteContractOf } from "../manifest-adapter";
import { dollarQuote } from "../sql";

const SITE = "11111111-1111-4111-8111-111111111111";
const col = (name: string, over: Partial<CollectionDef> = {}): CollectionDef => ({
  name,
  kind: "records",
  rules: { list: ["anyone"], get: ["anyone"], create: ["admin"] },
  schema: { type: "object", properties: { title: { type: "string", maxLength: 80 } } },
  fields: {},
  indexes: {},
  recipient: null,
  unique: [],
  states: null,
  references: {},
  ...over,
});
const contract = (over: Partial<SiteContractDef> = {}): SiteContractDef => ({ ...EMPTY_SITE_CONTRACT, schema_version: 2, ...over });

describe("manifest v2 adapter", () => {
  it("v1 canonicalizes with empty v2 fields (no change against a v1 shard row)", () => {
    const v1 = { schemaVersion: 1, collections: { a: { rules: { list: ["anyone"] } } } };
    expect(siteContractOf(v1)).toEqual(EMPTY_SITE_CONTRACT);
    const [a] = collectionsOf(v1);
    expect(a).toMatchObject({ recipient: null, unique: [], states: null, references: {} });
    const shardRow: CollectionDef = { name: "a", kind: "records", rules: { list: ["anyone"] }, schema: {}, fields: {}, indexes: {} };
    expect(sitePlanIsEmpty(planSite([shardRow], [a], EMPTY_SITE_CONTRACT, EMPTY_SITE_CONTRACT))).toBe(true);
  });
});

describe("planSite: the v2 diff and its backfills", () => {
  it("emits every change kind of the contract", () => {
    const cur = [col("listings"), col("requests", { unique: [{ fields: ["a"], nulls: "distinct" }, { fields: ["b"], nulls: "distinct" }] })];
    const des = [
      col("listings", { states: { field: "status", values: ["draft", "published"], initial: "draft", transitions: [] } }),
      col("requests", {
        unique: [{ fields: ["a"], nulls: "not_distinct" }, { fields: ["c", "d"], nulls: "distinct" }],
        references: { listing_id: { collection: "listings", on_delete: "restrict" } },
        recipient: { reference: "listing_id" },
      }),
    ];
    const act = { target: { collection: "listings", counter: "n" }, delta: 1, initial: 0, bounds: { min: 0, max: 9 }, creates: { collection: "requests", targetField: "listing_id" }, principals: ["signed_in"], idempotency: "required" as const };
    const p = planSite(cur, des, contract({ roles: ["seller", "mod"], capabilities: [] }), contract({
      roles: ["seller"], capabilities: ["payments"], actions: { reserve: act }, aggregates: { n: { collection: "requests", fn: "count", principals: ["admin"] } },
    }));
    expect(p.changes.map((c) => c.kind).sort()).toEqual([
      "actions_changed", "aggregates_changed", "capabilities_changed", "recipient_changed", "references_changed",
      "roles_changed", "states_changed", "unique_added", "unique_changed", "unique_removed",
    ]);
    expect(p.backfill.uniques).toEqual([
      { collection: "requests", fields: ["a"], nulls: "not_distinct" },
      { collection: "requests", fields: ["c", "d"], nulls: "distinct" },
    ]);
    expect(p.backfill.states).toEqual([{ collection: "listings", field: "status", values: ["draft", "published"], initial: "draft" }]);
    expect(p.backfill.references).toEqual([{ collection: "requests", field: "listing_id", target: "listings" }]);
    expect(p.backfill.recipients).toEqual([{ collection: "requests", field: "listing_id", target: "listings" }]);
    expect(p.backfill.counters).toEqual([{ action: "reserve", collection: "listings", counter: "n", initial: 0, bounds: { min: 0, max: 9 } }]);
    expect(p.backfill.removedRoles).toEqual(["mod"]);
  });

  it("an added collection has no records: no backfill for it", () => {
    const p = planSite([], [col("x", { unique: [{ fields: ["a"], nulls: "distinct" }] })], EMPTY_SITE_CONTRACT, contract());
    expect(p.collections.add.map((c) => c.name)).toEqual(["x"]);
    expect(p.backfill.uniques).toEqual([]);
  });
});

describe("applySitePlanSql: one transaction, locks first, checks before writes", () => {
  const cur = [col("requests")];
  const des = [col("requests", { unique: [{ fields: ["a"], nulls: "distinct" }] }), col("zeta")];
  const p = planSite(cur, des, contract({ roles: ["mod"] }), contract({ roles: [] }));
  const sql = applySitePlanSql(SITE, p, cur, contract({ roles: ["mod"] }), [{ user_id: "22222222-2222-4222-8222-222222222222", role: "mod" }]);

  it("locks the site row, then each touched collection in name order, before any check or write", () => {
    const i = (s: string) => sql.indexOf(s);
    expect(sql.startsWith("begin;")).toBe(true);
    expect(i("for update;")).toBeLessThan(i("pg_advisory_xact_lock"));
    const locks = [...sql.matchAll(/pg_advisory_xact_lock\(zsite\.manifest_lock_key\('[0-9a-f-]+'::uuid, '(\w+)'\)\)/g)].map((m) => m[1]);
    expect(locks).toEqual(["requests", "zeta"]);
    expect(i("pg_advisory_xact_lock")).toBeLessThan(i("collections_changed"));
    expect(i("zavi_refused")).toBeLessThan(i("insert into zsite.collections"));
    expect(i("update zsite.members m set role = 'user'")).toBeLessThan(i("insert into zsite.site_contracts"));
    expect(sql.trim().endsWith("commit;")).toBe(true);
  });

  it("re-checks the live rows AND the contract row (a concurrent change re-plans)", () => {
    expect(sql).toMatch(/from zsite\.collections where site_id = '[^']+'::uuid\) is distinct from/);
    expect(sql).toMatch(/from zsite\.site_contracts where site_id = '[^']+'::uuid\) is distinct from/);
  });

  it("demotes only the audited holders (else re-plans) and never deletes a member", () => {
    expect(sql).toMatch(/is distinct from \(b->'holders'\) then\s+raise exception 'collections_changed'/);
    expect(sql).toMatch(/v_n <> jsonb_array_length\(b->'holders'\)/);
    expect(sql).not.toMatch(/delete from zsite\.members/);
  });

  it("references are refused when broken and never nulled", () => {
    expect(sql).toMatch(/'broken_references'/);
    expect(sql).not.toMatch(/data - |set data = x\.data - /);
  });

  it("a manifest string can never close the DO block's quote (random tag, verified absent)", () => {
    const evil = col("requests", { schema: { type: "object", properties: { t: { type: "string", enum: ["$zavi$; drop schema zsite cascade; --", "$z$"] } } } });
    const p2 = planSite([col("requests")], [evil], EMPTY_SITE_CONTRACT, EMPTY_SITE_CONTRACT);
    const s2 = applySitePlanSql(SITE, p2, [col("requests")], null, []);
    const tag = /do (\$z[a-z0-9]+\$)/.exec(s2)?.[1] as string;
    expect(tag).toBeTruthy();
    const body = s2.slice(s2.indexOf(tag) + tag.length, s2.lastIndexOf(tag));
    expect(body.includes(tag)).toBe(false);
    expect(() => dollarQuote("x$zabc$y", () => "abc")).toThrow(/tag/);
  });
});

describe("refusals are founder-facing and carry the count", () => {
  const err = (d: object) => new Error(`ERROR: P0001: zavi_refused ${JSON.stringify(d)}`);
  it("unique duplicates", () => {
    const r = refusalFromError(err({ code: "unique_duplicates", collection: "slots", fields: ["listing_id", "starts_at"], groups: 2, records: 5 }));
    expect(r?.code).toBe("unique_duplicates");
    expect(r?.message).toMatch(/^5 records in "slots" share the same listing_id \+ starts_at \(2 duplicate groups\)/);
    expect(r?.message).toMatch(/Nothing was changed/);
  });
  it("invalid states, broken references, unresolvable recipients, action bounds", () => {
    expect(refusalFromError(err({ code: "invalid_states", collection: "l", field: "status", values: ["a"], records: 1 }))?.message).toMatch(/1 record in "l" have a status/);
    expect(refusalFromError(err({ code: "broken_references", collection: "r", field: "listing_id", target: "listings", records: 3 }))?.message).toMatch(/3 records .* never cleared silently/);
    expect(refusalFromError(err({ code: "recipient_unresolvable", collection: "r", field: "listing_id", target: "listings", records: 2 }))?.code).toBe("recipient_unresolvable");
    expect(refusalFromError(err({ code: "action_bounds", action: "reserve", collection: "slots", field: "booked_count", records: 1 }))?.message).toMatch(/bounds of action "reserve"/);
  });
  it("maps the shard's reason codes (K1 / K3) to founder-facing refusals", () => {
    for (const c of ["field_not_writable", "invalid_action_input", "invalid_idempotency_key", "cascade_too_large", "reference_restricted"]) {
      const r = refusalFromError(new Error(`ERROR: P0001: ${c}: status`));
      expect(r?.code, c).toBe(c);
      expect(r?.message, c).toMatch(/Nothing was changed/);
      expect(r?.message, c).not.toMatch(new RegExp(c));
    }
  });

  it("a unique violation at commit (a shard trigger) is a refusal too; other errors are not", () => {
    expect(refusalFromError(new Error('duplicate key value violates unique constraint "records_uk1"'))?.code).toBe("unique_duplicates");
    expect(refusalFromError(new Error("connection reset"))).toBeNull();
  });
});
