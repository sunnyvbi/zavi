import type { Step } from "./scenarios";
import { KERNEL_V2_EXAMPLE } from "../fixtures/kernel-v2";

type AnyObj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const MANIFEST_V2: AnyObj = (() => {
  const m: AnyObj = JSON.parse(JSON.stringify(KERNEL_V2_EXAMPLE));
  m.collections.requests.rules.update = ["owner"];
  m.collections.listings.schema.properties.sku = { type: "string", maxLength: 12 };
  m.collections.listings.unique = [{ fields: ["sku"], nulls: "distinct" }];
  m.collections.notes = {
    kind: "records",
    rules: { list: ["anyone"], get: ["anyone"], create: ["signed_in"], update: ["owner"], delete: ["owner", "admin"] },
    schema: {
      type: "object", required: ["slot_id"],
      properties: {
        slot_id: { type: "string", maxLength: 36, format: "uuid" },
        about: { type: "string", maxLength: 36, format: "uuid" },
        text: { type: "string", maxLength: 100 },
      },
    },
    references: { slot_id: { collection: "slots", on_delete: "cascade" }, about: { collection: "listings", on_delete: "nullify" } },
  };
  return m;
})();

export const SITE_V2 = "aaaaaaaa-0000-4000-8000-0000000000b2";
export const MEMBERS_V2: Array<{ id: string; role: string; status?: "active" | "disabled" }> = [
  { id: "b2000000-0000-4000-8000-000000000001", role: "admin" },
  { id: "b2000000-0000-4000-8000-000000000002", role: "seller" },
  { id: "b2000000-0000-4000-8000-000000000003", role: "seller" },
  { id: "b2000000-0000-4000-8000-000000000004", role: "user" },
  { id: "b2000000-0000-4000-8000-000000000005", role: "user" },
  { id: "b2000000-0000-4000-8000-000000000006", role: "seller", status: "disabled" },
];
export const CALLERS_V2: Record<string, { sub: string | null; siteRole: string | null }> = {
  anon: { sub: null, siteRole: null },
  admin: { sub: MEMBERS_V2[0].id, siteRole: "admin" },
  seller: { sub: MEMBERS_V2[1].id, siteRole: "seller" },
  seller2: { sub: MEMBERS_V2[2].id, siteRole: "seller" },
  buyer: { sub: MEMBERS_V2[3].id, siteRole: "user" },
  other: { sub: MEMBERS_V2[4].id, siteRole: "user" },
  disabled: { sub: MEMBERS_V2[5].id, siteRole: "seller" },
  forgedAdmin: { sub: MEMBERS_V2[3].id, siteRole: "admin" },
};

export type KernelStep =
  | { as: string; op: "transition"; c: string; id: string; to: string }
  | { as: string; op: "action"; name: string; target?: string; record?: string; data?: unknown; key?: string; save?: string }
  | { as: string; op: "aggregate"; name: string; filter?: unknown };

const K = (s: string) => `key-${s}`.padEnd(20, "x");
const NOPE = "ffffffff-0000-4000-8000-00000000ffff";
const AT = "2026-10-03T09:00:00Z";

export const STEPS_V2: Array<Step | KernelStep> = [
  { as: "seller", op: "create", c: "listings", data: { title: "Kayak" }, save: "l1" },
  { as: "seller", op: "create", c: "listings", data: { title: "Sneaky", status: "published" } },
  { as: "seller", op: "create", c: "listings", data: { title: "Honest", status: "draft" }, save: "ldraft" },
  { as: "buyer", op: "get", c: "listings", id: "$l1" },
  { as: "anon", op: "list", c: "listings" },
  { as: "seller", op: "get", c: "listings", id: "$l1" },
  { as: "seller", op: "list", c: "listings" },
  { as: "seller", op: "transition", c: "listings", id: "$l1", to: "archived" },
  { as: "buyer", op: "transition", c: "listings", id: "$l1", to: "published" },
  { as: "seller2", op: "transition", c: "listings", id: "$l1", to: "published" },
  { as: "buyer", op: "transition", c: "listings", id: NOPE, to: "published" },
  { as: "seller", op: "transition", c: "listings", id: "$l1", to: "nowhere" },
  { as: "seller", op: "transition", c: "requests", id: "$l1", to: "accepted" },
  { as: "seller", op: "transition", c: "slots", id: "$l1", to: "published" },
  { as: "seller", op: "transition", c: "listings", id: "$l1", to: "published" },
  { as: "seller", op: "transition", c: "listings", id: "$l1", to: "published" },
  { as: "anon", op: "get", c: "listings", id: "$l1" },
  { as: "anon", op: "list", c: "listings" },
  { as: "buyer", op: "transition", c: "listings", id: "$l1", to: "archived" },
  { as: "seller", op: "update", c: "listings", id: "$l1", patch: { status: "archived" } },
  { as: "seller", op: "update", c: "listings", id: "$l1", patch: { status: null } },
  { as: "seller", op: "update", c: "listings", id: "$l1", patch: { title: "Kayak 2", status: "published" } },
  { as: "seller2", op: "create", c: "listings", data: { title: "Bike" }, save: "l2" },
  { as: "seller2", op: "transition", c: "listings", id: "$l2", to: "published" },
  { as: "buyer", op: "create", c: "listings", data: { title: "Nope" } },
  { as: "disabled", op: "create", c: "listings", data: { title: "Nope" } },

  { as: "seller", op: "create", c: "listings", data: { title: "A", sku: "X1" } },
  { as: "seller2", op: "create", c: "listings", data: { title: "B", sku: "X1" } },
  { as: "seller2", op: "create", c: "listings", data: { title: "C" } },
  { as: "seller2", op: "create", c: "listings", data: { title: "D", sku: "X2" }, save: "lx2" },
  { as: "seller2", op: "update", c: "listings", id: "$lx2", patch: { sku: "X1" } },

  { as: "buyer", op: "create", c: "requests", data: { listing_id: "$l1", message: "Saturday?", status: "pending" }, save: "r1" },
  { as: "buyer", op: "create", c: "requests", data: { listing_id: "$ldraft", message: "x", status: "pending" } },
  { as: "buyer", op: "create", c: "requests", data: { listing_id: NOPE, message: "x", status: "pending" } },
  { as: "buyer", op: "create", c: "requests", data: { listing_id: "not-a-uuid", message: "x", status: "pending" } },
  { as: "buyer", op: "create", c: "requests", data: { listing_id: 7, message: "x", status: "pending" } },
  { as: "buyer", op: "create", c: "requests", data: { listing_id: "$l1", message: "x", status: "accepted" } },
  { as: "buyer", op: "create", c: "requests", data: { message: "x", status: "pending" } },
  { as: "anon", op: "create", c: "requests", data: { listing_id: "$l1", message: "x" }, key: K("anonreq") },
  { as: "seller", op: "get", c: "requests", id: "$r1" },
  { as: "seller2", op: "get", c: "requests", id: "$r1" },
  { as: "seller", op: "list", c: "requests" },
  { as: "other", op: "list", c: "requests" },
  { as: "buyer", op: "list", c: "requests" },
  { as: "admin", op: "list", c: "requests" },
  { as: "buyer", op: "transition", c: "requests", id: "$r1", to: "accepted" },
  { as: "seller", op: "transition", c: "requests", id: "$r1", to: "accepted" },
  { as: "seller", op: "transition", c: "requests", id: "$r1", to: "declined" },
  { as: "buyer", op: "update", c: "requests", id: "$r1", patch: { listing_id: "$l2" } },
  { as: "buyer", op: "update", c: "requests", id: "$r1", patch: { message: "Sunday then" } },
  { as: "seller", op: "update", c: "requests", id: "$r1", patch: { message: "hijack" } },
  { as: "seller", op: "get", c: "requests", id: "$r1" },
  { as: "buyer", op: "create", c: "requests", data: { listing_id: "$l1", message: "again", status: "pending" }, save: "r2" },
  { as: "seller", op: "transition", c: "requests", id: "$r2", to: "cancelled" },
  { as: "buyer", op: "transition", c: "requests", id: "$r2", to: "cancelled" },
  { as: "buyer", op: "transition", c: "requests", id: "$r2", to: "accepted" },

  { as: "seller", op: "create", c: "slots", data: { listing_id: "$l1", starts_at: AT, capacity: 2, booked_count: 0 }, save: "s1" },
  { as: "seller", op: "create", c: "slots", data: { listing_id: "$l1", starts_at: AT, capacity: 9, booked_count: 0 } },
  { as: "seller", op: "create", c: "slots", data: { listing_id: "$l1", starts_at: "2026-10-04T09:00:00Z", capacity: 3, booked_count: 3 } },
  { as: "seller", op: "create", c: "slots", data: { listing_id: "$l1", starts_at: "2026-10-04T09:00:00Z", capacity: 3 }, save: "s2" },
  { as: "buyer", op: "create", c: "bookings", data: { slot_id: "$s1", status: "booked" } },
  { as: "buyer", op: "action", name: "reserve_slot", target: "$s1", data: { note: "two adults" }, key: K("b1"), save: "bk1" },
  { as: "buyer", op: "action", name: "reserve_slot", target: "$s1", data: { note: "two adults" }, key: K("b1") },
  { as: "buyer", op: "action", name: "reserve_slot", target: "$s1", data: { note: "changed" }, key: K("b1") },
  { as: "other", op: "action", name: "reserve_slot", target: "$s1", data: { note: "two adults" }, key: K("b1") },
  { as: "anon", op: "action", name: "reserve_slot", target: "$s1", key: K("anon") },
  { as: "buyer", op: "action", name: "reserve_slot", target: "$s1", key: "short" },
  { as: "buyer", op: "action", name: "reserve_slot", target: "$s1" },
  { as: "buyer", op: "action", name: "ghost", target: "$s1", key: K("ghost") },
  { as: "buyer", op: "action", name: "reserve_slot", target: NOPE, key: K("nope") },
  { as: "buyer", op: "action", name: "reserve_slot", target: "$l1", key: K("wrongcol") },
  { as: "buyer", op: "action", name: "reserve_slot", record: "$s1", key: K("shape1") },
  { as: "buyer", op: "action", name: "cancel_slot", target: "$s1", key: K("shape2") },
  { as: "buyer", op: "action", name: "reserve_slot", target: "$s1", data: { status: "cancelled" }, key: K("state") },
  { as: "buyer", op: "action", name: "reserve_slot", target: "$s1", data: { slot_id: "$s2" }, key: K("tf") },
  { as: "buyer", op: "action", name: "reserve_slot", target: "$s1", data: { extra: 1 }, key: K("schema") },
  { as: "other", op: "action", name: "reserve_slot", target: "$s1", key: K("o1") },
  { as: "admin", op: "action", name: "reserve_slot", target: "$s1", key: K("a1") },
  { as: "anon", op: "get", c: "slots", id: "$s1" },
  { as: "seller", op: "update", c: "slots", id: "$s1", patch: { booked_count: 0 } },
  { as: "seller", op: "update", c: "slots", id: "$s1", patch: { capacity: 1 } },
  { as: "seller", op: "update", c: "slots", id: "$s1", patch: { capacity: 5 } },
  { as: "buyer", op: "list", c: "bookings" },
  { as: "seller", op: "list", c: "bookings" },
  { as: "other", op: "action", name: "cancel_slot", record: "$bk1", key: K("oc") },
  { as: "buyer", op: "action", name: "cancel_slot", record: "$bk1", key: K("bc") },
  { as: "buyer", op: "action", name: "cancel_slot", record: "$bk1", key: K("bc") },
  { as: "buyer", op: "action", name: "cancel_slot", record: "$bk1", key: K("bc2") },
  { as: "buyer", op: "get", c: "bookings", id: "$bk1" },
  { as: "anon", op: "get", c: "slots", id: "$s1" },

  { as: "buyer", op: "aggregate", name: "booking_count" },
  { as: "forgedAdmin", op: "aggregate", name: "booking_count" },
  { as: "admin", op: "aggregate", name: "ghost" },
  { as: "admin", op: "aggregate", name: "booking_count" },
  { as: "admin", op: "aggregate", name: "booking_count", filter: { status: "booked" } },
  { as: "admin", op: "aggregate", name: "booking_count", filter: { status: "cancelled", slot_id: "$s1" } },
  { as: "admin", op: "aggregate", name: "booking_count", filter: { slot_id: "$s2" } },
  { as: "admin", op: "aggregate", name: "booking_count", filter: { status: { eq: "booked" } } },
  { as: "admin", op: "aggregate", name: "booking_count", filter: { status: 1 } },
  { as: "admin", op: "aggregate", name: "booking_count", filter: { note: "x" } },

  { as: "seller", op: "delete", c: "listings", id: "$l1" },
  { as: "seller", op: "create", c: "slots", data: { listing_id: "$l1", starts_at: "2026-10-05T09:00:00Z", capacity: 1 }, save: "s3" },
  { as: "buyer", op: "create", c: "notes", data: { slot_id: "$s3", about: "$l2", text: "bring water" }, save: "n1" },
  { as: "buyer", op: "create", c: "notes", data: { slot_id: "$s2", about: "$l2", text: "parking" }, save: "n2" },
  { as: "buyer", op: "create", c: "notes", data: { slot_id: "$s2", about: "$ldraft" } },
  { as: "seller", op: "delete", c: "slots", id: "$s3" },
  { as: "buyer", op: "get", c: "notes", id: "$n1" },
  { as: "seller2", op: "delete", c: "listings", id: "$l2" },
  { as: "buyer", op: "get", c: "notes", id: "$n2" },
  { as: "anon", op: "list", c: "notes" },
];
