import { describe, expect, it } from "vitest";
import { nonAdditiveChanges, notAdditiveReason } from "../additive";
import { EMPTY_SITE_CONTRACT, type CollectionDef, type SiteContractDef } from "../contract";

const col = (over: Partial<CollectionDef> = {}): CollectionDef => ({
  name: "orders",
  kind: "records",
  rules: { create: ["anyone"], list: ["admin"], get: ["admin", "owner"] },
  schema: {
    type: "object",
    properties: {
      name: { type: "string", maxLength: 80, minLength: 1 },
      size: { type: "string", maxLength: 10, enum: ["s", "m", "l"] },
      qty: { type: "integer", minimum: 1, maximum: 10 },
      tags: { type: "array", maxItems: 5, items: { type: "string", maxLength: 20 } },
      status: { type: "string", maxLength: 20 },
      customer: { type: "string", maxLength: 40, format: "uuid" },
    },
    required: ["name"],
  },
  fields: { name: { read: ["admin", "owner"] } },
  indexes: {},
  ...over,
});
const withProps = (props: Record<string, unknown>, required = ["name"]) => {
  const base = col();
  return col({ schema: { ...base.schema, properties: { ...(base.schema.properties as object), ...props }, required } });
};
const C = EMPTY_SITE_CONTRACT;
const check = (d: CollectionDef, c: CollectionDef = col()) => nonAdditiveChanges([c], [d], C, C);

describe("nonAdditiveChanges: what a live site's contract may not lose", () => {
  it("identical, or pure additions: nothing", () => {
    expect(check(col())).toEqual([]);
    const grown = col({
      rules: { create: ["anyone"], list: ["admin", "user"], get: ["admin", "owner"], update: ["admin"] },
      schema: {
        ...col().schema,
        properties: {
          ...(col().schema.properties as object),
          name: { type: "string", maxLength: 200 },
          size: { type: "string", maxLength: 10, enum: ["s", "m", "l", "xl"] },
          qty: { type: "integer", minimum: 0 },
          note: { type: "string", maxLength: 500 },
        },
        required: [],
      },
      fields: { name: { read: ["admin", "owner", "user"] } },
      indexes: { name: { type: "text", ops: ["eq"], sort: false } },
    });
    expect(check(grown)).toEqual([]);
    expect(nonAdditiveChanges([col()], [col(), col({ name: "invoices" })], C, C)).toEqual([]);
  });

  it("removing a collection; an archived one may stay away or come back", () => {
    expect(nonAdditiveChanges([col()], [], C, C)).toEqual(['removes the collection "orders"']);
    expect(nonAdditiveChanges([col({ archived: true })], [], C, C)).toEqual([]);
    expect(nonAdditiveChanges([col({ archived: true })], [col()], C, C)).toEqual([]);
    const revived = nonAdditiveChanges([col({ archived: true })], [col({ rules: { create: ["anyone"] } })], C, C);
    expect(revived[0]).toMatch(/tightens its rules.*\(reviving an archived collection\)/);
  });

  it("removing or reinterpreting a field", () => {
    const { qty: _q, ...rest } = col().schema.properties as Record<string, unknown>;
    expect(check(col({ schema: { ...col().schema, properties: rest } }))).toEqual(['collection "orders" removes the field "qty"']);
    expect(check(withProps({ qty: { type: "number" } }))[0]).toMatch(/"qty" changes type from integer to number/);
    expect(check(withProps({ customer: { type: "string", maxLength: 40, format: "email" } }))[0]).toMatch(/format to email/);
    expect(check(withProps({ name: { type: "string", maxLength: 40 } }))[0]).toMatch(/lowers maxLength to 40/);
    expect(check(withProps({ name: { type: "string", maxLength: 80, minLength: 3 } }))[0]).toMatch(/raises minLength to 3/);
    expect(check(withProps({ size: { type: "string", maxLength: 10, enum: ["s", "m"] } }))[0]).toMatch(/drops the value\(s\) l/);
    expect(check(withProps({ status: { type: "string", maxLength: 20, enum: ["new"] } }))[0]).toMatch(/restricts the field to a list/);
    expect(check(withProps({ qty: { type: "integer", minimum: 2, maximum: 10 } }))[0]).toMatch(/raises minimum to 2/);
    expect(check(withProps({ qty: { type: "integer", minimum: 1, maximum: 5 } }))[0]).toMatch(/lowers maximum to 5/);
    expect(check(withProps({ tags: { type: "array", maxItems: 3, items: { type: "string", maxLength: 20 } } }))[0]).toMatch(/lowers maxItems to 3/);
    expect(check(withProps({ tags: { type: "array", maxItems: 5, items: { type: "string", maxLength: 5 } } }))[0]).toMatch(/items lowers maxLength to 5/);
  });

  it("new required fields", () => {
    expect(check(withProps({}, ["name", "qty"]))).toEqual(['collection "orders" makes the existing field "qty" required']);
    expect(check(withProps({ phone: { type: "string", maxLength: 20 } }, ["name", "phone"]))).toEqual(['collection "orders" adds "phone" as a required field']);
  });

  it("a tighter policy: rules, masks", () => {
    expect(check(col({ rules: { create: ["anyone"], get: ["admin", "owner"] } }))[0]).toMatch(/tightens its rules: list \(removed\)/);
    expect(check(col({ rules: { create: ["user"], list: ["admin"], get: ["admin", "owner"] } }))[0]).toMatch(/create for anyone/);
    expect(check(col({ fields: { name: { read: ["admin"] } } }))[0]).toMatch(/tightens the mask of "name": read for owner/);
    expect(check(col({ fields: { name: { read: ["admin", "owner"] }, qty: { read: ["admin"] } } }))[0]).toMatch(/adds a read mask to the field "qty"/);
    expect(check(col({ fields: {} }))).toEqual([]);
    expect(check({ ...withProps({ secret: { type: "string", maxLength: 9 } }), fields: { name: { read: ["admin", "owner"] }, secret: { read: ["admin"] } } })).toEqual([]);
  });

  it("state machines: new on a NEW field is fine; on an existing field or narrowed is not", () => {
    const sm = { field: "stage", values: ["new", "done"], initial: "new", transitions: [{ from: "new", to: "done", principals: ["admin", "owner"] }] };
    const withStage = (states: CollectionDef["states"]) => {
      const c = withProps({ stage: { type: "string", maxLength: 10 } }, ["name"]);
      return { ...c, states };
    };
    expect(check(col({ ...withProps({ stage: { type: "string", maxLength: 10 } }), states: sm }))).toEqual([]);
    expect(check(col({ states: { ...sm, field: "status" } }))[0]).toMatch(/turns the existing field "status" into a state machine/);
    const live = withStage(sm);
    expect(check(withStage({ ...sm, values: ["new"] }), live)).toContain('collection "orders" drops the state(s) done');
    expect(check(withStage({ ...sm, transitions: [] }), live)).toContain('collection "orders" removes the transition new -> done');
    expect(check(withStage({ ...sm, transitions: [{ from: "new", to: "done", principals: ["admin"] }] }), live)).toContain('collection "orders" narrows who may move new -> done');
    expect(check(withStage({ ...sm, values: ["new", "done", "void"], transitions: [...sm.transitions, { from: "done", to: "void", principals: ["admin"] }] }), live)).toEqual([]);
    expect(check(withStage(null), live)).toContain('collection "orders" removes its state machine');
    expect(check(withStage({ ...sm, read: { new: ["admin"] } }), live)).toContain('collection "orders" restricts who may read its states');
  });

  it("references, recipient, unique rules", () => {
    const ref = { customer: { collection: "customers", on_delete: "restrict" as const } };
    expect(check(col({ references: ref }))[0]).toMatch(/turns the existing field "customer" into a reference/);
    expect(check(col({ ...withProps({ cust2: { type: "string", maxLength: 40 } }), references: { cust2: ref.customer } }))).toEqual([]);
    expect(check(col({ references: {} }), col({ references: ref }))[0]).toMatch(/removes the reference "customer"/);
    expect(check(col({ references: { customer: { ...ref.customer, on_delete: "cascade" } } }), col({ references: ref }))[0]).toMatch(/changes the reference "customer"/);
    expect(check(col({ recipient: { reference: "other" } }), col({ recipient: { reference: "customer" } }))[0]).toMatch(/changes its recipient/);
    expect(check(col({ recipient: { reference: "customer" } }))[0]).toMatch(/derives a recipient from the existing field "customer"/);
    expect(check(col({ ...withProps({ cust2: { type: "string", maxLength: 40 } }), references: { cust2: ref.customer }, recipient: { reference: "cust2" } }))).toEqual([]);
    expect(check(col({ unique: [{ fields: ["name"], nulls: "distinct" }] }))[0]).toMatch(/adds a unique rule on name/);
    expect(check(col({ unique: [{ fields: ["name"], nulls: "not_distinct" }] }), col({ unique: [{ fields: ["name"], nulls: "distinct" }] }))[0]).toMatch(/stricter/);
    expect(check(col({ unique: [] }), col({ unique: [{ fields: ["name"], nulls: "distinct" }] }))).toEqual([]);
  });

  it("the site contract: roles, capabilities, actions, aggregates may only grow", () => {
    const act = { target: { collection: "orders", counter: "qty" }, delta: 1, initial: 0, bounds: { min: 0, max: 9 }, creates: { collection: "orders", targetField: "x" }, principals: ["user"], idempotency: "required" as const };
    const agg = { collection: "orders", fn: "count" as const, principals: ["admin"] };
    const live: SiteContractDef = { schema_version: 2, roles: ["admin", "staff"], capabilities: ["email"], actions: { book: act }, aggregates: { total: agg } };
    expect(nonAdditiveChanges([], [], live, { ...live, roles: ["admin", "staff", "vip"], actions: { ...live.actions, cancel: act } })).toEqual([]);
    expect(nonAdditiveChanges([], [], live, { ...live, roles: ["admin"] })).toEqual(["removes the role(s) staff"]);
    expect(nonAdditiveChanges([], [], live, { ...live, capabilities: [] })).toEqual(["removes the capability email"]);
    expect(nonAdditiveChanges([], [], live, { ...live, actions: { book: { ...act, delta: 2 } } })).toEqual(['changes the action "book"']);
    expect(nonAdditiveChanges([], [], live, { ...live, aggregates: {} })).toEqual(['removes the aggregate "total"']);
  });

  it("the refusal tells the AI what to keep, and caps a long list", () => {
    const r = notAdditiveReason(Array.from({ length: 10 }, (_, i) => `removes the field "f${i}"`));
    expect(r).toMatch(/not additive: it removes the field "f0"/);
    expect(r).toMatch(/\(and 2 more\)/);
    expect(r).toMatch(/Nothing was changed\.$/);
  });
});
