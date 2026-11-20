import { describe, it, expect } from "vitest";
import { DevStore, type Caller } from "../files/src/zavi/devstore";
import { validateManifest } from "../manifest";
import { v2, type AnyObj } from "./fixtures/kernel-v2";

const ADMIN = "11111111-0000-4000-8000-000000000001";
const SELLER = "11111111-0000-4000-8000-000000000002";
const BUYER = "11111111-0000-4000-8000-000000000003";
const OTHER = "11111111-0000-4000-8000-000000000004";
const SELLER2 = "11111111-0000-4000-8000-000000000005";
const as = (sub: string | null, siteRole: string | null = null): Caller => ({ sub, siteRole });
const A = as(ADMIN), S = as(SELLER), B = as(BUYER), O = as(OTHER), S2 = as(SELLER2), ANON = as(null);
const KEY = (n: number) => `key-${String(n).padStart(16, "0")}`;

function setup(mut?: (m: AnyObj) => void, quotas = {}) {
  const raw = v2();
  mut?.(raw);
  const m = validateManifest(raw);
  if (!m.ok) throw new Error(JSON.stringify(m.issues));
  let n = 0;
  let t = Date.UTC(2026, 9, 1);
  const store = new DevStore({ manifest: m.value, quotas, now: () => (t += 7), uuid: () => `22222222-0000-4000-8000-${String(++n).padStart(12, "0")}` });
  store.setMember(ADMIN, "admin");
  store.setMember(SELLER, "seller");
  store.setMember(SELLER2, "seller");
  store.setMember(BUYER, "user");
  store.setMember(OTHER, "user");
  let k = 0;
  const key = () => KEY(++k);
  const listing = (who = S, title = "Bike") => store.create(who, "listings", { title, status: "draft" }, null).id;
  const publish = (id: string, who = S) => store.transition(who, "listings", id, "published");
  const slot = (listingId: string, capacity = 2, who = S, starts = "2026-10-02T10:00:00Z") =>
    store.create(who, "slots", { listing_id: listingId, starts_at: starts, capacity, booked_count: 0 }, null).id;
  return { store, key, listing, publish, slot, setNow: (x: number) => { t = x; } };
}
const reason = (f: () => unknown) => {
  try { f(); } catch (e) { return (e as { reason: string }).reason; }
  return "no error";
};

describe("states", () => {
  it("create injects the initial state; a caller may only send the initial value", () => {
    const w = setup();
    expect(reason(() => w.store.create(S, "listings", { title: "x", status: "published" }, null))).toBe("field_not_writable: status");
    const id = w.store.create(S, "listings", { title: "x" }, null).id;
    expect(w.store.get(S, "listings", id)?.data.status).toBe("draft");
    expect(w.store.create(S, "listings", { title: "y", status: "draft" }, null).id).toBeTruthy();
  });

  it("states.read narrows list/get: a draft is invisible to everyone but owner/admin", () => {
    const w = setup();
    const id = w.listing();
    expect(w.store.get(B, "listings", id)).toBeNull();
    expect(w.store.get(ANON, "listings", id)).toBeNull();
    expect(w.store.list(B, "listings").items).toEqual([]);
    expect(w.store.get(S, "listings", id)?.data.status).toBe("draft");
    w.publish(id);
    expect(w.store.get(ANON, "listings", id)?.data.status).toBe("published");
    expect(w.store.list(B, "listings").items).toHaveLength(1);
  });

  it("generic update cannot change the state, not even by removing it", () => {
    const w = setup();
    const id = w.listing();
    expect(reason(() => w.store.update(S, "listings", id, { status: "published" }))).toBe("field_not_writable: status");
    expect(reason(() => w.store.update(S, "listings", id, { status: null }))).toBe("field_not_writable: status");
    expect(w.store.update(S, "listings", id, { status: "draft", title: "y" })).toEqual({ id, updated: true });
  });

  it("transitions: allowed edge, illegal edge, and unauthorized/missing look the same", () => {
    const w = setup();
    const id = w.listing();
    expect(reason(() => w.store.transition(S, "listings", id, "archived"))).toBe("transition_conflict");
    expect(reason(() => w.store.transition(B, "listings", id, "published"))).toBe("not_found");
    expect(reason(() => w.store.transition(B, "listings", "99999999-0000-4000-8000-000000000000", "published"))).toBe("not_found");
    expect(reason(() => w.store.transition(S2, "listings", id, "published"))).toBe("not_found");
    expect(w.store.transition(S, "listings", id, "published")).toEqual({ id, from: "draft", to: "published", transitioned: true });
    expect(reason(() => w.store.transition(B, "listings", id, "archived"))).toBe("not_found");
    expect(w.store.transition(S, "listings", id, "published")).toEqual({ id, from: "published", to: "published", transitioned: false });
    expect(reason(() => w.store.transition(ANON, "listings", id, "archived"))).toBe("anonymous_write_forbidden");
    expect(w.store.transition(A, "listings", id, "archived")).toMatchObject({ transitioned: true });
  });
});

describe("references and the recipient", () => {
  it("the recipient is the referenced listing's owner; a raw recipient id is refused", () => {
    const w = setup();
    const l = w.listing();
    w.publish(l);
    const r = w.store.create(B, "requests", { listing_id: l, message: "hi", status: "pending" }, null).id;
    expect(w.store.get(S, "requests", r)?.data.message).toBe("hi");
    expect(w.store.get(O, "requests", r)).toBeNull();
    expect(w.store.list(S, "requests").items.map((x) => x.id)).toEqual([r]);
    expect(w.store.list(O, "requests").items).toEqual([]);
    expect(reason(() => w.store.create(B, "requests", { listing_id: l, message: "hi", status: "pending", recipient_id: OTHER }, null))).toMatch(/^schema_violation/);
  });

  it("missing, hidden (draft), ownerless and other-collection targets are one error", () => {
    const w = setup();
    const draft = w.listing();
    const ownerless = w.store.seedRecord("listings", { title: "platform", status: "published" }, null);
    const someSlot = w.slot(draft);
    const req = (l: string) => reason(() => w.store.create(B, "requests", { listing_id: l, message: "m", status: "pending" }, null));
    expect(req("99999999-0000-4000-8000-000000000000")).toBe("invalid_reference");
    expect(req(draft)).toBe("invalid_reference");
    expect(req(ownerless)).toBe("invalid_reference");
    expect(req(someSlot)).toBe("invalid_reference");
    expect(req("not-a-uuid")).toBe("invalid_reference");
    expect(reason(() => w.store.create(B, "requests", { listing_id: 5, message: "m", status: "pending" }, null))).toBe("invalid_reference");
  });

  it("the source reference is immutable, the recipient follows nobody", () => {
    const w = setup((m) => { m.collections.requests.rules.update = ["owner"]; });
    const l1 = w.listing(); w.publish(l1);
    const l2 = w.listing(S2); w.publish(l2, S2);
    const r = w.store.create(B, "requests", { listing_id: l1, message: "m", status: "pending" }, null).id;
    expect(reason(() => w.store.update(B, "requests", r, { listing_id: l2 }))).toBe("field_not_writable: listing_id");
    expect(w.store.update(B, "requests", r, { message: "edited" })).toEqual({ id: r, updated: true });
    expect(w.store.get(S, "requests", r)?.data.message).toBe("edited");
    expect(w.store.get(S2, "requests", r)).toBeNull();
  });

  it("recipient transitions: the recipient accepts, the sender cannot; sender cancels", () => {
    const w = setup();
    const l = w.listing(); w.publish(l);
    const r = w.store.create(B, "requests", { listing_id: l, message: "m", status: "pending" }, null).id;
    expect(reason(() => w.store.transition(B, "requests", r, "accepted"))).toBe("not_found");
    expect(w.store.transition(S, "requests", r, "accepted")).toMatchObject({ transitioned: true });
    const r2 = w.store.create(B, "requests", { listing_id: l, message: "m2", status: "pending" }, null).id;
    expect(reason(() => w.store.transition(S, "requests", r2, "cancelled"))).toBe("not_found");
    expect(w.store.transition(B, "requests", r2, "cancelled")).toMatchObject({ transitioned: true });
  });

  it("recipient spam limit: 30 creates per recipient per collection per minute", () => {
    const w = setup();
    w.setNow(Date.UTC(2026, 9, 1, 12, 0, 0));
    const l = w.listing(); w.publish(l);
    for (let i = 0; i < 30; i++) w.store.create(B, "requests", { listing_id: l, message: `m${i}`, status: "pending" }, null);
    expect(reason(() => w.store.create(O, "requests", { listing_id: l, message: "spam", status: "pending" }, null))).toBe("recipient_rate_limited");
    w.setNow(Date.UTC(2026, 9, 1, 12, 1, 5));
    expect(w.store.create(O, "requests", { listing_id: l, message: "later", status: "pending" }, null).id).toBeTruthy();
  });

  it("on_delete: restrict blocks, cascade removes, nullify drops the key", () => {
    const w = setup((m) => {
      m.collections.notes = {
        rules: { list: ["anyone"], get: ["anyone"], create: ["signed_in"], update: ["owner"], delete: ["owner"] },
        schema: { type: "object", properties: { slot_id: { type: "string", maxLength: 36, format: "uuid" }, about: { type: "string", maxLength: 36, format: "uuid" }, t: { type: "string", maxLength: 9 } }, required: ["slot_id"] },
        references: { slot_id: { collection: "slots", on_delete: "cascade" }, about: { collection: "listings", on_delete: "nullify" } },
      };
      m.collections.slots.references.listing_id.on_delete = "cascade";
    });
    const l = w.listing(); w.publish(l);
    const s = w.slot(l);
    const n = w.store.create(B, "notes", { slot_id: s, about: l, t: "x" }, null).id;
    const r = w.store.create(B, "requests", { listing_id: l, message: "m", status: "pending" }, null).id;
    expect(reason(() => w.store.delete(S, "listings", l))).toBe("reference_restricted");
    w.store.delete(B, "requests", r);
    w.store.delete(S, "listings", l);
    expect(w.store.get(S, "slots", s)).toBeNull();
    expect(w.store.get(B, "notes", n)).toBeNull();

    const l2 = w.listing(); w.publish(l2);
    const s2 = w.slot(l2);
    const n2 = w.store.create(B, "notes", { slot_id: s2, about: l2, t: "y" }, null).id;
    w.store.delete(B, "notes", n2);
    const l3 = w.listing(); w.publish(l3);
    const n3 = w.store.create(B, "notes", { slot_id: s2, about: l3, t: "z" }, null).id;
    w.store.delete(S, "listings", l3);
    expect(w.store.get(B, "notes", n3)?.data).toEqual({ slot_id: s2, t: "z" });
  });

  it("a nullify that would duplicate a not_distinct unique tuple refuses the whole delete", () => {
    const w = setup((m) => {
      m.collections.tags = {
        rules: { list: ["anyone"], get: ["anyone"], create: ["signed_in"], update: ["owner"], delete: ["owner"] },
        schema: { type: "object", properties: { listing_id: { type: "string", maxLength: 36, format: "uuid" }, tag: { type: "string", maxLength: 9 } }, required: ["tag"] },
        references: { listing_id: { collection: "listings", on_delete: "nullify" } },
        unique: [{ fields: ["listing_id", "tag"], nulls: "not_distinct" }],
      };
    });
    const l = w.listing(); w.publish(l);
    w.store.create(B, "tags", { tag: "x" }, null);
    const t = w.store.create(B, "tags", { listing_id: l, tag: "x" }, null).id;
    expect(reason(() => w.store.delete(S, "listings", l))).toBe("unique_conflict");
    expect(w.store.get(S, "listings", l)).not.toBeNull();
    expect(w.store.get(B, "tags", t)?.data.listing_id).toBe(l);
  });

  it("one delete may touch at most 1,000 dependent rows", () => {
    const w = setup((m) => { m.collections.slots.references.listing_id.on_delete = "cascade"; m.collections.slots.unique = []; });
    const l = w.listing(); w.publish(l);
    for (let i = 0; i < 1001; i++) w.store.seedRecord("slots", { listing_id: l, starts_at: "2026-10-02T10:00:00Z", capacity: 1, booked_count: 0 }, SELLER);
    expect(reason(() => w.store.delete(S, "listings", l))).toBe("cascade_too_large");
    expect(w.store.get(S, "listings", l)).not.toBeNull();
  });
});

describe("unique", () => {
  it("not_distinct: absent and null collide; distinct: a missing component never collides", () => {
    const w = setup((m) => {
      m.collections.slots.schema.required = ["capacity", "booked_count", "listing_id"];
      m.collections.slots.unique = [{ fields: ["listing_id", "starts_at"], nulls: "not_distinct" }];
      m.collections.listings.schema.properties.sku = { type: "string", maxLength: 9 };
      m.collections.listings.unique = [{ fields: ["sku"], nulls: "distinct" }];
    });
    const l = w.listing(); w.publish(l);
    w.store.create(S, "slots", { listing_id: l, capacity: 1, booked_count: 0 }, null);
    expect(reason(() => w.store.create(S, "slots", { listing_id: l, capacity: 2, booked_count: 0 }, null))).toBe("unique_conflict");
    w.store.create(S, "listings", { title: "a", status: "draft" }, null);
    w.store.create(S, "listings", { title: "b", status: "draft" }, null);
    w.store.create(S, "listings", { title: "c", status: "draft", sku: "X1" }, null);
    expect(reason(() => w.store.create(S2, "listings", { title: "d", status: "draft", sku: "X1" }, null))).toBe("unique_conflict");
    const e = w.store.create(S2, "listings", { title: "e", status: "draft", sku: "X2" }, null).id;
    expect(reason(() => w.store.update(S2, "listings", e, { sku: "X1" }))).toBe("unique_conflict");
  });
});

describe("actions", () => {
  it("reserve within capacity, refuse beyond it, never cross the bound", () => {
    const w = setup();
    const l = w.listing(); w.publish(l);
    const s = w.slot(l, 2);
    const r1 = w.store.runAction(B, "reserve_slot", { targetId: s, data: { note: "a" } }, w.key());
    expect(r1).toMatchObject({ action: "reserve_slot", target_id: s, counter: 1, replayed: false });
    w.store.runAction(O, "reserve_slot", { targetId: s }, w.key());
    expect(reason(() => w.store.runAction(B, "reserve_slot", { targetId: s }, w.key()))).toBe("action_bound");
    expect(w.store.get(S, "slots", s)?.data.booked_count).toBe(2);
    expect(w.store.list(B, "bookings").items.map((x) => x.data)).toEqual([{ slot_id: s, note: "a", status: "booked" }]);
  });

  it("generic create/update cannot touch the counter", () => {
    const w = setup();
    const l = w.listing(); w.publish(l);
    expect(reason(() => w.store.create(S, "slots", { listing_id: l, starts_at: "2026-10-02T10:00:00Z", capacity: 3, booked_count: 3 }, null))).toBe("field_not_writable: booked_count");
    const s = w.store.create(S, "slots", { listing_id: l, starts_at: "2026-10-02T10:00:00Z", capacity: 3, booked_count: 0 }, null).id;
    expect(w.store.get(S, "slots", s)?.data.booked_count).toBe(0);
    expect(reason(() => w.store.update(S, "slots", s, { booked_count: 0 }))).toBe("no error");
    expect(reason(() => w.store.update(S, "slots", s, { booked_count: 3 }))).toBe("field_not_writable: booked_count");
    w.store.runAction(B, "reserve_slot", { targetId: s }, w.key());
    w.store.runAction(O, "reserve_slot", { targetId: s }, w.key());
    expect(reason(() => w.store.update(S, "slots", s, { capacity: 1 }))).toBe("action_bound");
  });

  it("idempotency: a replay returns the receipt; another request or caller with the key conflicts", () => {
    const w = setup();
    const l = w.listing(); w.publish(l);
    const s = w.slot(l, 5);
    const k = w.key();
    const first = w.store.runAction(B, "reserve_slot", { targetId: s }, k);
    expect(w.store.runAction(B, "reserve_slot", { targetId: s }, k)).toEqual({ ...first, replayed: true });
    expect(w.store.get(S, "slots", s)?.data.booked_count).toBe(1);
    expect(reason(() => w.store.runAction(B, "reserve_slot", { targetId: s, data: { note: "x" } }, k))).toBe("idempotency_conflict");
    expect(reason(() => w.store.runAction(O, "reserve_slot", { targetId: s }, k))).toBe("idempotency_conflict");
    expect(reason(() => w.store.runAction(B, "reserve_slot", { targetId: s }, null))).toBe("idempotency_key_required");
    expect(reason(() => w.store.runAction(B, "reserve_slot", { targetId: s }, "short"))).toBe("invalid_idempotency_key");
  });

  it("the inverse runs once, by the booking owner only, and restores capacity", () => {
    const w = setup();
    const l = w.listing(); w.publish(l);
    const s = w.slot(l, 1);
    const { record_id } = w.store.runAction(B, "reserve_slot", { targetId: s }, w.key());
    expect(reason(() => w.store.runAction(O, "cancel_slot", { recordId: record_id }, w.key()))).toBe("not_found");
    const k = w.key();
    expect(w.store.runAction(B, "cancel_slot", { recordId: record_id }, k)).toMatchObject({ action: "cancel_slot", target_id: s, record_id, counter: 0, replayed: false });
    expect(w.store.runAction(B, "cancel_slot", { recordId: record_id }, k)).toMatchObject({ replayed: true });
    expect(reason(() => w.store.runAction(B, "cancel_slot", { recordId: record_id }, w.key()))).toBe("transition_conflict");
    expect(w.store.get(S, "slots", s)?.data.booked_count).toBe(0);
    expect(w.store.get(B, "bookings", record_id)?.data.status).toBe("cancelled");
  });

  it("anonymous callers only when declared; unknown actions and invisible targets", () => {
    const w = setup();
    const l = w.listing(); w.publish(l);
    const s = w.slot(l);
    expect(reason(() => w.store.runAction(ANON, "reserve_slot", { targetId: s }, w.key()))).toBe("action_not_allowed");
    expect(reason(() => w.store.runAction(B, "ghost", { targetId: s }, w.key()))).toBe("action_not_allowed");
    expect(reason(() => w.store.runAction(B, "reserve_slot", { targetId: "99999999-0000-4000-8000-000000000000" }, w.key()))).toBe("not_found");
    expect(reason(() => w.store.runAction(B, "reserve_slot", { recordId: s }, w.key()))).toBe("invalid_action_input");
    expect(reason(() => w.store.runAction(B, "cancel_slot", { targetId: s }, w.key()))).toBe("invalid_action_input");
    expect(reason(() => w.store.runAction(B, "reserve_slot", { targetId: s, data: { status: "booked" } }, w.key()))).toBe("field_not_writable: status");
    expect(reason(() => w.store.runAction(B, "reserve_slot", { targetId: s, data: { slot_id: "99999999-0000-4000-8000-000000000000" } }, w.key()))).toBe("invalid_action_input");
  });

  it("a refusal half-way through an action leaves nothing behind (quota rollback)", () => {
    const w = setup(undefined, { maxWritesPerMin: 6 });
    const l = w.listing(); w.publish(l);
    const s = w.slot(l, 5);
    w.store.runAction(B, "reserve_slot", { targetId: s }, w.key());
    expect(reason(() => w.store.runAction(O, "reserve_slot", { targetId: s }, w.key()))).toBe("quota_exceeded");
    expect(w.store.get(S, "slots", s)?.data.booked_count).toBe(1);
    expect(w.store.list(O, "bookings").items).toEqual([]);
    expect(w.store.receipts.size).toBe(1);
  });

  it("the action-created collection cannot be written generically", () => {
    const w = setup();
    const l = w.listing(); w.publish(l);
    const s = w.slot(l, 1);
    expect(reason(() => w.store.create(B, "bookings", { slot_id: s, status: "booked" }, null))).toBe("rls");
    expect(w.store.get(S, "slots", s)?.data.booked_count).toBe(0);
  });
});

describe("aggregates", () => {
  it("admin counts with filters over visible rows; others are refused", () => {
    const w = setup();
    const l = w.listing(); w.publish(l);
    const s = w.slot(l, 5);
    w.store.runAction(B, "reserve_slot", { targetId: s }, w.key());
    const { record_id } = w.store.runAction(O, "reserve_slot", { targetId: s }, w.key());
    w.store.runAction(O, "cancel_slot", { recordId: record_id }, w.key());
    expect(w.store.aggregate(A, "booking_count", {})).toEqual({ value: 2 });
    expect(w.store.aggregate(A, "booking_count", { slot_id: s, status: "booked" })).toEqual({ value: 1 });
    expect(w.store.aggregate(A, "booking_count", { status: "cancelled" })).toEqual({ value: 1 });
    expect(reason(() => w.store.aggregate(A, "booking_count", { status: { eq: "cancelled" } }))).toBe("invalid_filter");
    expect(reason(() => w.store.aggregate(B, "booking_count", {}))).toBe("aggregate_not_allowed");
    expect(reason(() => w.store.aggregate(ANON, "booking_count", {}))).toBe("aggregate_not_allowed");
    expect(reason(() => w.store.aggregate(A, "ghost", {}))).toBe("aggregate_not_allowed");
    expect(reason(() => w.store.aggregate(A, "booking_count", { note: "x" }))).toBe("filter_not_allowed");
    expect(reason(() => w.store.aggregate(A, "booking_count", { status: 5 }))).toBe("invalid_filter");
  });

  it("sum/avg over a number index; a forged token role is ignored", () => {
    const w = setup((m) => {
      m.collections.slots.indexes.capacity = { type: "number", ops: ["eq"], sort: false };
      m.aggregates.capacity_total = { collection: "slots", fn: "sum", field: "capacity", principals: ["admin", "role:moderator"] };
      m.aggregates.capacity_avg = { collection: "slots", fn: "avg", field: "capacity", principals: ["admin"] };
    });
    const l = w.listing(); w.publish(l);
    w.slot(l, 2, S, "2026-10-02T10:00:00Z");
    w.slot(l, 5, S, "2026-10-02T11:00:00Z");
    expect(w.store.aggregate(A, "capacity_total", {})).toEqual({ value: 7 });
    expect(w.store.aggregate(A, "capacity_avg", {})).toEqual({ value: 3.5 });
    expect(reason(() => w.store.aggregate(as(BUYER, "admin"), "capacity_total", {}))).toBe("aggregate_not_allowed");
  });

  it("over 10,000 visible rows is aggregate_too_large", () => {
    const w = setup((m) => { m.collections.slots.unique = []; m.aggregates.slot_count = { collection: "slots", fn: "count", principals: ["admin"] }; }, { maxRecords: 20000 });
    const l = w.listing(); w.publish(l);
    for (let i = 0; i < 10001; i++) w.store.seedRecord("slots", { listing_id: l, starts_at: "2026-10-02T10:00:00Z", capacity: 1, booked_count: 0 }, SELLER);
    expect(reason(() => w.store.aggregate(A, "slot_count", {}))).toBe("aggregate_too_large");
  });
});

describe("member administration", () => {
  it("admins list, set roles, disable and remove; non-admins are refused", () => {
    const w = setup();
    expect(reason(() => w.store.memberList(S, {}))).toBe("member_admin_required");
    expect(reason(() => w.store.memberSetRole(S, BUYER, "seller"))).toBe("member_admin_required");
    expect(reason(() => w.store.memberSetRole(as(BUYER, "admin"), BUYER, "admin"))).toBe("member_admin_required");
    expect(w.store.memberList(A, { limit: 2 }).items.map((x) => x.user_id)).toEqual([ADMIN, SELLER]);
    const page2 = w.store.memberList(A, { limit: 2, cursor: SELLER });
    expect(page2.items.map((x) => x.user_id)).toEqual([BUYER, OTHER]);
    expect(w.store.memberSetRole(A, BUYER, "moderator")).toMatchObject({ user_id: BUYER, role: "moderator", status: "active" });
    expect(reason(() => w.store.memberSetRole(A, BUYER, "ghost"))).toBe("invalid_role");
    expect(reason(() => w.store.memberSetRole(A, "99999999-0000-4000-8000-000000000000", "user"))).toBe("member_not_found");
    expect(w.store.memberDisable(A, OTHER)).toMatchObject({ status: "disabled" });
    expect(w.store.member(O)).toBeNull();
    expect(w.store.memberRemove(A, OTHER)).toEqual({ user_id: OTHER, removed: true });
  });

  it("the last active admin cannot be demoted, disabled or removed", () => {
    const w = setup();
    expect(reason(() => w.store.memberSetRole(A, ADMIN, "user"))).toBe("last_admin");
    expect(reason(() => w.store.memberDisable(A, ADMIN))).toBe("last_admin");
    expect(reason(() => w.store.memberRemove(A, ADMIN))).toBe("last_admin");
    w.store.memberSetRole(A, SELLER, "admin");
    expect(w.store.memberSetRole(A, ADMIN, "user")).toMatchObject({ role: "user" });
  });

  it("a removed role loses its rule access at once (the member row is authoritative)", () => {
    const w = setup();
    expect(w.store.create(S, "listings", { title: "t", status: "draft" }, null).id).toBeTruthy();
    w.store.memberSetRole(A, SELLER, "user");
    expect(reason(() => w.store.create(as(SELLER, "seller"), "listings", { title: "t2", status: "draft" }, null))).toBe("rls");
  });
});

describe("transition compare-and-set (twin of shard 0013)", () => {
  it("expect must hold; set is written with the state; a CAS into the current state is a conflict", () => {
    const w = setup();
    const id = w.listing();
    expect(reason(() => w.store.transition(S, "listings", id, "published", { expect: { title: "nope" } }))).toBe("transition_conflict");
    expect(w.store.get(S, "listings", id)?.data.status).toBe("draft");
    expect(w.store.transition(S, "listings", id, "published", { expect: { title: "Bike" }, set: { title: "Bike 2" } }).transitioned).toBe(true);
    expect(w.store.get(S, "listings", id)?.data).toMatchObject({ status: "published", title: "Bike 2" });
    expect(reason(() => w.store.transition(S, "listings", id, "published", { set: { title: "x" } }))).toBe("transition_conflict");
    expect(w.store.get(S, "listings", id)?.data.title).toBe("Bike 2");
    expect(w.store.transition(S, "listings", id, "published").transitioned).toBe(false);
  });

  it("set: never the state, undeclared fields, references, nulls; and it needs the update rule", () => {
    const w = setup();
    const id = w.listing();
    expect(reason(() => w.store.transition(S, "listings", id, "published", { set: { status: "archived" } }))).toBe("field_not_writable: status");
    expect(reason(() => w.store.transition(S, "listings", id, "published", { set: { nope: 1 } }))).toBe("field_not_writable: nope");
    expect(reason(() => w.store.transition(S, "listings", id, "published", { set: { title: null } }))).toBe("invalid_transition");
    expect(reason(() => w.store.transition(S, "listings", id, "published", { expect: { nope: 1 } }))).toBe("invalid_transition");
    w.publish(id);
    const rq = w.store.create(B, "requests", { listing_id: id, message: "hi" }, null).id;
    expect(reason(() => w.store.transition(S, "requests", rq, "accepted", { set: { message: "x" } }))).toBe("forbidden");
    expect(reason(() => w.store.transition(A, "requests", rq, "accepted", { set: { listing_id: id } }))).toBe("forbidden");
    expect(w.store.transition(S, "requests", rq, "accepted", { expect: { message: "hi" } }).transitioned).toBe(true);
  });
});
