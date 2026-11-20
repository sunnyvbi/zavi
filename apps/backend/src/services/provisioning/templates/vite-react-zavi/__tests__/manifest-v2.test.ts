import { describe, it, expect } from "vitest";
import {
  validateManifest, diffManifest, shardCollectionRow, siteContractRow, callableActions, V2_LIMITS,
  type Manifest, type RecordsCollection,
} from "../manifest";
import { v2, type AnyObj } from "./fixtures/kernel-v2";

function codes(input: unknown): string[] {
  const r = validateManifest(input);
  return r.ok ? [] : r.issues.map((i) => i.code);
}
function ok(input: unknown): Manifest {
  const r = validateManifest(input);
  if (!r.ok) throw new Error(JSON.stringify(r.issues, null, 1));
  return r.value;
}
const rec = (m: Manifest, n: string) => m.collections[n] as RecordsCollection;
function col(refs: Record<string, string> = {}, extra: AnyObj = {}): AnyObj {
  const properties: AnyObj = { title: { type: "string", maxLength: 50 } };
  const references: AnyObj = {};
  for (const [f, target] of Object.entries(refs)) {
    properties[f] = { type: "string", maxLength: 36, format: "uuid" };
    references[f] = { collection: target, on_delete: "restrict" };
  }
  return {
    rules: { list: ["anyone"], get: ["anyone"], create: ["signed_in"], update: ["owner"], delete: ["owner"] },
    schema: { type: "object", properties, required: Object.keys(refs) },
    references,
    ...extra,
  };
}

describe("schemaVersion 2: accepts", () => {
  it("the contract's full example, with every v2 field canonical", () => {
    const m = ok(v2());
    expect(m.schemaVersion).toBe(2);
    expect(m.roles).toEqual(["moderator", "seller"]);
    expect(m.capabilities).toEqual([]);
    expect(rec(m, "requests").recipient).toEqual({ reference: "listing_id" });
    expect(rec(m, "requests").rules.list).toEqual(["owner", "recipient", "admin"]);
    expect(rec(m, "slots").unique).toEqual([{ fields: ["listing_id", "starts_at"], nulls: "not_distinct" }]);
    expect(rec(m, "listings").states?.read?.published).toEqual(["anyone"]);
    expect(rec(m, "bookings").states?.read).toBeUndefined();
    expect(m.actions.reserve_slot.bounds).toEqual({ min: 0, maxField: "capacity" });
    expect(m.aggregates.booking_count).toEqual({ collection: "bookings", fn: "count", filters: ["slot_id", "status"], principals: ["admin"] });
    expect(callableActions(m)).toEqual({ reserve_slot: { action: "reserve_slot", inverse: false }, cancel_slot: { action: "reserve_slot", inverse: true } });
  });

  it("the hash ignores key order, principal order, transition order and role order", () => {
    const a = validateManifest(v2());
    const b2 = v2();
    b2.roles = ["seller", "moderator", ];
    b2.collections.requests.states.transitions.reverse();
    b2.collections.requests.rules.list = ["admin", "recipient", "owner", "owner"];
    const reordered = JSON.parse(JSON.stringify({ aggregates: b2.aggregates, actions: b2.actions, collections: b2.collections, roles: b2.roles, capabilities: [], schemaVersion: 2 }));
    const b = validateManifest(reordered);
    if (!a.ok || !b.ok) throw new Error("expected valid");
    expect(b.hash).toBe(a.hash);
    const c = v2();
    c.actions.reserve_slot.delta = 2;
    expect((validateManifest(c) as { hash: string }).hash).not.toBe(a.hash);
  });

  it("a v1 manifest still validates and canonicalizes with empty v2 fields", () => {
    const m = ok({ schemaVersion: 1, collections: { posts: { rules: { list: ["role:anything"] }, schema: { type: "object", properties: { t: { type: "string", maxLength: 9 } } } } } });
    expect(m).toMatchObject({ schemaVersion: 1, roles: [], capabilities: [], actions: {}, aggregates: {} });
    expect(rec(m, "posts")).toMatchObject({ recipient: null, unique: [], states: null, references: {} });
    expect(rec(m, "posts").rules.list).toEqual(["role:anything"]);
  });

  it("dedicated capabilities are declared, deduplicated and sorted", () => {
    const d = v2();
    d.capabilities = ["webhooks", "payments", "jobs", "secrets", "interval_overlap", "arbitrary_joins"];
    expect(ok(d).capabilities).toEqual(["arbitrary_joins", "interval_overlap", "jobs", "payments", "secrets", "webhooks"]);
  });

  it("shard rows carry every v2 column; site_contracts carries roles/actions/aggregates", () => {
    const m = ok(v2());
    const row = shardCollectionRow("requests", m.collections.requests);
    expect(row).toMatchObject({ recipient: { reference: "listing_id" }, uniques: [], references: { listing_id: { collection: "listings", on_delete: "restrict" } } });
    expect(row.states?.initial).toBe("pending");
    expect(siteContractRow(m)).toEqual({ schema_version: 2, roles: ["moderator", "seller"], capabilities: [], actions: m.actions, aggregates: m.aggregates });
  });

  it("a reference chain exactly 4 deep is allowed", () => {
    const d = { schemaVersion: 2, collections: { a: col({ b: "b" }), b: col({ c: "c" }), c: col({ d: "d" }), d: col({ e: "e" }), e: col() } };
    expect(codes(d)).toEqual([]);
  });
});

describe("schemaVersion 2: refuses malicious and mistaken manifests", () => {
  it("v2 keys in a v1 manifest", () => {
    const d = v2();
    d.schemaVersion = 1;
    const c = codes(d);
    expect(c).toContain("unknown_key");
    expect(validateManifest(d).ok).toBe(false);
  });

  it("reference cycles: self, two-step and three-step", () => {
    expect(codes({ schemaVersion: 2, collections: { a: col({ parent: "a" }, { references: { parent: { collection: "a", on_delete: "nullify" } }, schema: { type: "object", properties: { parent: { type: "string", maxLength: 36, format: "uuid" } } } }) } })).toContain("reference_cycle");
    expect(codes({ schemaVersion: 2, collections: { a: col({ b: "b" }), b: col({ a: "a" }) } })).toContain("reference_cycle");
    expect(codes({ schemaVersion: 2, collections: { a: col({ b: "b" }), b: col({ c: "c" }), c: col({ a: "a" }) } })).toContain("reference_cycle");
  });

  it("a reference chain 5 deep, a missing target, a files target, a non-uuid field", () => {
    const deep = { schemaVersion: 2, collections: { a: col({ b: "b" }), b: col({ c: "c" }), c: col({ d: "d" }), d: col({ e: "e" }), e: col({ f: "f" }), f: col() } };
    expect(codes(deep)).toContain("reference_depth");
    expect(codes({ schemaVersion: 2, collections: { a: col({ b: "ghost" }) } })).toContain("unknown_collection");
    expect(codes({ schemaVersion: 2, collections: { a: col({ b: "pics" }), pics: { kind: "files", rules: { list: ["anyone"], get: ["anyone"] } } } })).toContain("unknown_collection");
    const d = v2();
    d.collections.slots.schema.properties.listing_id = { type: "string", maxLength: 36 };
    expect(codes(d)).toContain("invalid_reference_field");
  });

  it("over budget: references per collection and per site", () => {
    expect(codes({ schemaVersion: 2, collections: { base: col(), a: col({ r1: "base", r2: "base", r3: "base", r4: "base", r5: "base" }) } })).toContain("reference_budget");
    const cols: AnyObj = { base: col() };
    for (let i = 0; i < 17; i++) cols[`c${i}`] = col({ r1: "base", r2: "base", r3: "base", r4: "base" });
    expect(codes({ schemaVersion: 2, collections: cols })).toContain("reference_budget");
  });

  it("nullify on a required field, an unknown on_delete", () => {
    const d = v2();
    d.collections.slots.references.listing_id.on_delete = "nullify";
    expect(codes(d)).toContain("nullify_required_field");
    d.collections.slots.references.listing_id.on_delete = "set_default";
    expect(codes(d)).toContain("invalid_reference");
  });

  it("recipient without a required reference, or naming a non-reference field", () => {
    const d = v2();
    d.collections.requests.schema.required = ["message", "status"];
    expect(codes(d)).toContain("recipient_needs_required_reference");
    const e = v2();
    e.collections.requests.recipient = { reference: "message" };
    expect(codes(e)).toContain("recipient_needs_required_reference");
    const f = v2();
    f.collections.requests.recipient = { reference: "listing_id", user_id: "x" };
    expect(codes(f)).toContain("invalid_recipient");
  });

  it("the recipient principal where it means nothing: no recipient on the collection, or in create", () => {
    const d = v2();
    d.collections.slots.rules.get = ["recipient"];
    expect(codes(d)).toContain("recipient_not_allowed");
    const e = v2();
    e.collections.requests.rules.create = ["recipient"];
    expect(codes(e)).toContain("recipient_not_allowed");
    const f = v2();
    f.aggregates.booking_count.principals = ["recipient"];
    expect(codes(f)).toContain("principal_not_allowed");
  });

  it("undeclared, reserved, malformed and too many roles", () => {
    const d = v2();
    d.collections.listings.rules.create = ["role:ghost"];
    expect(codes(d)).toContain("undeclared_role");
    const masks = v2();
    masks.collections.listings.fields = { title: { write: ["role:ghost"] } };
    expect(codes(masks)).toContain("undeclared_role");
    const tr = v2();
    tr.collections.listings.states.transitions[0].principals = ["role:ghost"];
    expect(codes(tr)).toContain("undeclared_role");
    const act = v2();
    act.actions.reserve_slot.principals = ["role:ghost"];
    expect(codes(act)).toContain("undeclared_role");
    expect(codes({ ...v2(), roles: ["admin"] })).toContain("reserved_role");
    expect(codes({ ...v2(), roles: ["user"] })).toContain("reserved_role");
    expect(codes({ ...v2(), roles: ["Seller"] })).toContain("invalid_role");
    expect(codes({ ...v2(), roles: ["seller", "seller", "moderator"] })).toContain("invalid_role");
    expect(codes({ ...v2(), roles: ["a", "b", "c", "d", "e", "f", "g", "h", "seller", "moderator"] })).toContain("role_budget");
  });

  it("an action without bounds, or with half a bound", () => {
    const d = v2();
    delete d.actions.reserve_slot.bounds;
    expect(codes(d)).toContain("action_needs_bounds");
    const e = v2();
    e.actions.reserve_slot.bounds = { min: 0 };
    expect(codes(e)).toContain("action_needs_bounds");
    const f = v2();
    f.actions.reserve_slot.bounds = { maxField: "capacity" };
    expect(codes(f)).toContain("action_needs_bounds");
    const g = v2();
    g.actions.reserve_slot.bounds = { min: 0, max: 10, maxField: "capacity" };
    expect(codes(g)).toContain("action_needs_bounds");
    const h = v2();
    h.actions.reserve_slot.bounds = { min: 0, maxField: "starts_at" };
    expect(codes(h)).toContain("invalid_bounds");
    const i = v2();
    i.actions.reserve_slot.bounds = { min: 5, max: 1 };
    expect(codes(i)).toContain("invalid_bounds");
  });

  it("bad deltas, initials, counters, idempotency and targets", () => {
    const bad = (mut: (a: AnyObj, d: AnyObj) => void, code: string) => {
      const d = v2();
      mut(d.actions.reserve_slot, d);
      expect(codes(d), code).toContain(code);
    };
    bad((a) => { a.delta = 0; }, "invalid_delta");
    bad((a) => { a.delta = 1001; }, "invalid_delta");
    bad((a) => { a.delta = 1.5; }, "invalid_delta");
    bad((a) => { a.inverse.delta = -1001; }, "invalid_delta");
    bad((a) => { a.initial = 0.5; }, "invalid_action");
    bad((a) => { a.target.counter = "starts_at"; }, "invalid_counter");
    bad((a) => { a.target.counter = "listing_id"; }, "invalid_counter");
    bad((a) => { delete a.idempotency; }, "idempotency_required");
    bad((a) => { a.inverse.idempotency = "optional"; }, "idempotency_required");
    bad((a) => { a.target.collection = "ghost"; }, "invalid_action_target");
    bad((a) => { a.creates.targetField = "note"; }, "invalid_action_creates");
    bad((a) => { a.creates.collection = "requests"; a.creates.targetField = "listing_id"; }, "invalid_action_creates");
    bad((a) => { a.inverse.transition = { from: "booked", to: "booked" }; }, "invalid_transition");
    bad((a) => { a.inverse.principals = ["anyone"]; }, "anyone_not_allowed");
    bad((a) => { a.inverse.name = "reserve_slot"; }, "duplicate_action");
    bad((a) => { a.principals = []; }, "invalid_principals");
    bad((a, d) => { d.actions.second = { ...JSON.parse(JSON.stringify(a)), initial: 1, inverse: undefined }; }, "invalid_counter");
  });

  it("a collection an action creates into cannot also be generically creatable (it would bypass the bound)", () => {
    const d = v2();
    d.collections.bookings.rules.create = ["signed_in"];
    expect(codes(d)).toContain("action_collection_creatable");
  });

  it("an action with an inverse cannot share its created collection with another action", () => {
    const d = v2();
    d.actions.waitlist = { ...JSON.parse(JSON.stringify(d.actions.reserve_slot)), target: { collection: "slots", counter: "capacity" } };
    delete d.actions.waitlist.inverse;
    d.actions.waitlist.bounds = { min: 0, max: 100 };
    d.actions.waitlist.initial = 1;
    expect(codes(d)).toContain("shared_action_collection");
  });

  it("an inverse on a collection without states", () => {
    const d = v2();
    delete d.collections.bookings.states;
    d.collections.bookings.schema.properties.status = { type: "string", maxLength: 9 };
    expect(codes(d)).toContain("inverse_needs_states");
  });

  it("more than 16 callable action names (inverses count) and more than 8 aggregates", () => {
    const d = v2();
    for (let i = 0; i < 8; i++) {
      d.actions[`act_${i}`] = { ...JSON.parse(JSON.stringify(d.actions.reserve_slot)), inverse: { ...d.actions.reserve_slot.inverse, name: `undo_${i}` } };
    }
    expect(codes(d)).toContain("action_budget");
    const e = v2();
    for (let i = 0; i < 8; i++) e.aggregates[`agg_${i}`] = { ...e.aggregates.booking_count };
    expect(codes(e)).toContain("aggregate_budget");
  });

  it("aggregates: field rules, filter budget, principals, list and field-read coverage", () => {
    const bad = (mut: (g: AnyObj, d: AnyObj) => void, code: string) => {
      const d = v2();
      mut(d.aggregates.booking_count, d);
      expect(codes(d), code).toContain(code);
    };
    bad((g) => { g.field = "note"; }, "invalid_aggregate");
    bad((g) => { g.fn = "sum"; g.field = "note"; }, "invalid_aggregate");
    bad((g) => { g.fn = "median"; }, "invalid_aggregate");
    bad((g) => { g.filters = ["slot_id", "status", "note"]; }, "invalid_aggregate");
    bad((g) => { g.filters = ["note"]; }, "invalid_aggregate");
    bad((g) => { g.principals = ["signed_in"]; }, "principal_not_allowed");
    bad((g) => { g.principals = ["anyone"]; }, "principal_not_allowed");
    bad((g) => { g.principals = ["owner"]; }, "principal_not_allowed");
    bad((g) => { g.principals = []; }, "invalid_principals");
    bad((g) => { g.principals = ["role:seller"]; }, "aggregate_exceeds_list");
    bad((g, d) => { d.collections.bookings.fields = { slot_id: { read: ["owner"] } }; }, "aggregate_exceeds_field_read");
    bad((g) => { g.collection = "ghost"; }, "unknown_collection");
  });

  it("states: budget, field shape, initial, transitions and complete read map", () => {
    const bad = (mut: (s: AnyObj, d: AnyObj) => void, code: string) => {
      const d = v2();
      mut(d.collections.listings.states, d);
      expect(codes(d), code).toContain(code);
    };
    bad((s, d) => { d.collections.listings.schema.required = ["title"]; }, "state_field_mismatch");
    bad((s, d) => { d.collections.listings.schema.properties.status.enum = ["draft", "published"]; }, "state_field_mismatch");
    bad((s, d) => { delete d.collections.listings.schema.properties.status.enum; }, "state_field_mismatch");
    bad((s) => { s.initial = "gone"; }, "invalid_states");
    bad((s) => { s.transitions.push({ from: "draft", to: "draft", principals: ["admin"] }); }, "invalid_transition");
    bad((s) => { s.transitions.push({ ...s.transitions[0] }); }, "invalid_transition");
    bad((s) => { s.transitions[0].principals = ["anyone"]; }, "anyone_not_allowed");
    bad((s) => { delete s.read.archived; }, "incomplete_state_read");
    bad((s) => { s.read.ghost = ["admin"]; }, "invalid_states");
    const many = Array.from({ length: 17 }, (_, i) => `s${i}`);
    bad((s, d) => { s.values = many; d.collections.listings.schema.properties.status.enum = many; delete s.read; s.initial = "s0"; s.transitions = []; }, "state_budget");
    const t33 = Array.from({ length: 33 }, (_, i) => ({ from: "draft", to: i % 2 ? "published" : "archived", principals: ["admin"] }));
    bad((s) => { s.transitions = t33; }, "state_budget");
  });

  it("unique: budget, field types and null modes", () => {
    const bad = (u: unknown, code: string) => {
      const d = v2();
      d.collections.slots.unique = u;
      expect(codes(d), code).toContain(code);
    };
    const t = { fields: ["capacity"], nulls: "distinct" };
    bad([t, { ...t, fields: ["starts_at"] }, { ...t, fields: ["listing_id"] }, { ...t, fields: ["booked_count"] }, { ...t, fields: ["capacity", "starts_at"] }], "unique_budget");
    bad([{ fields: ["capacity", "starts_at", "listing_id", "booked_count", "capacity"], nulls: "distinct" }], "unique_budget");
    bad([{ fields: [], nulls: "distinct" }], "unique_budget");
    bad([{ fields: ["capacity"], nulls: "maybe" }], "invalid_unique");
    bad([{ fields: ["capacity"] }], "invalid_unique");
    bad([{ fields: ["ghost"], nulls: "distinct" }], "undeclared_field");
    bad([t, t], "invalid_unique");
    const arr = v2();
    arr.collections.slots.schema.properties.tags = { type: "array", maxItems: 3, items: { type: "string", maxLength: 5 } };
    arr.collections.slots.unique = [{ fields: ["tags"], nulls: "distinct" }];
    expect(codes(arr)).toContain("invalid_unique");
  });

  it("unknown capabilities and v2 keys on a files area", () => {
    expect(codes({ ...v2(), capabilities: ["bitcoin"] })).toContain("unknown_capability");
    const d = v2();
    d.collections.pics = { kind: "files", rules: { list: ["anyone"], get: ["anyone"] }, states: { field: "x" } };
    expect(codes(d)).toContain("files_area_shape");
  });

  it("budgets match the contract", () => {
    expect(V2_LIMITS).toMatchObject({
      roles: 8, uniquePerCollection: 4, uniqueFields: 4, stateValues: 16, stateTransitions: 32, referencesPerCollection: 4,
      referencesPerSite: 64, referenceDepth: 4, deleteFanout: 1000, callableActions: 16, aggregates: 8, aggregateFilters: 2,
      aggregateScanRows: 10000, aggregateStatementMs: 250, maxDelta: 1000, recipientCreatesPerMinute: 30,
    });
  });
});

describe("diffManifest: v2 changes", () => {
  it("v1 -> v2 names every new kernel feature", () => {
    const prev = ok({ schemaVersion: 1, collections: { slots: { rules: {}, schema: { type: "object", properties: { listing_id: { type: "string", maxLength: 36, format: "uuid" }, starts_at: { type: "string", maxLength: 40, format: "date-time" }, capacity: { type: "integer", minimum: 1, maximum: 100 }, booked_count: { type: "integer", minimum: 0, maximum: 100 } } } } } });
    const next = ok(v2());
    const types = new Set(diffManifest(prev, next).map((c) => c.type));
    for (const t of ["roles_changed", "unique_added", "references_changed", "actions_changed", "aggregates_changed", "collection_added"]) expect(types, t).toContain(t);
    const d2 = v2();
    d2.collections.requests.states.transitions.pop();
    d2.collections.slots.unique[0].nulls = "distinct";
    delete d2.collections.requests.recipient;
    d2.collections.requests.rules.list = ["owner", "admin"];
    d2.collections.requests.rules.get = ["owner", "admin"];
    d2.collections.requests.states.read = { pending: ["owner"], accepted: ["owner"], declined: ["owner"], cancelled: ["owner"] };
    for (const t of d2.collections.requests.states.transitions) t.principals = ["admin"];
    d2.capabilities = ["jobs"];
    d2.roles = ["seller"];
    const changes = diffManifest(next, ok(d2));
    const ct = changes.map((c) => c.type);
    for (const t of ["states_changed", "unique_changed", "recipient_changed", "capabilities_changed", "roles_changed"]) expect(ct, t).toContain(t);
    expect(changes.find((c) => c.type === "roles_changed")).toMatchObject({ removed: ["moderator"], breaking: true });
    expect(changes.find((c) => c.type === "capabilities_changed")).toMatchObject({ added: ["jobs"], breaking: true });
  });

  it("an identical manifest diffs to nothing", () => {
    expect(diffManifest(ok(v2()), ok(v2()))).toEqual([]);
  });
});
