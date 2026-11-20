
export const KERNEL_V2_EXAMPLE = {
  schemaVersion: 2,
  roles: ["seller", "moderator"],
  capabilities: [],
  collections: {
    listings: {
      kind: "records",
      rules: { list: ["anyone"], get: ["anyone"], create: ["admin", "role:seller"], update: ["owner", "admin"], delete: ["owner", "admin"] },
      schema: { type: "object", properties: { title: { type: "string", maxLength: 120 }, status: { type: "string", maxLength: 9, enum: ["draft", "published", "archived"] } }, required: ["title", "status"] },
      fields: {},
      indexes: {},
      unique: [],
      references: {},
      states: {
        field: "status",
        values: ["draft", "published", "archived"],
        initial: "draft",
        read: { draft: ["owner", "admin"], published: ["anyone"], archived: ["owner", "admin"] },
        transitions: [
          { from: "draft", to: "published", principals: ["owner", "admin"] },
          { from: "published", to: "archived", principals: ["owner", "admin"] },
        ],
      },
    },
    requests: {
      kind: "records",
      rules: { list: ["owner", "recipient", "admin"], get: ["owner", "recipient", "admin"], create: ["signed_in"], update: [], delete: ["owner", "admin"] },
      schema: { type: "object", properties: { listing_id: { type: "string", maxLength: 36, format: "uuid" }, message: { type: "string", maxLength: 1000 }, status: { type: "string", maxLength: 9, enum: ["pending", "accepted", "declined", "cancelled"] } }, required: ["listing_id", "message", "status"] },
      fields: {},
      indexes: { listing_id: { type: "text", ops: ["eq"], sort: false } },
      recipient: { reference: "listing_id" },
      references: { listing_id: { collection: "listings", on_delete: "restrict" } },
      unique: [],
      states: { field: "status", values: ["pending", "accepted", "declined", "cancelled"], initial: "pending", read: { pending: ["owner", "recipient", "admin"], accepted: ["owner", "recipient", "admin"], declined: ["owner", "recipient", "admin"], cancelled: ["owner", "recipient", "admin"] }, transitions: [{ from: "pending", to: "accepted", principals: ["recipient", "admin"] }, { from: "pending", to: "declined", principals: ["recipient", "admin"] }, { from: "pending", to: "cancelled", principals: ["owner", "admin"] }] },
    },
    slots: {
      kind: "records",
      rules: { list: ["anyone"], get: ["anyone"], create: ["admin", "role:seller"], update: ["owner", "admin"], delete: ["owner", "admin"] },
      schema: { type: "object", properties: { listing_id: { type: "string", maxLength: 36, format: "uuid" }, starts_at: { type: "string", maxLength: 40, format: "date-time" }, capacity: { type: "integer", minimum: 1, maximum: 100 }, booked_count: { type: "integer", minimum: 0, maximum: 100 } }, required: ["listing_id", "starts_at", "capacity", "booked_count"] },
      fields: {},
      indexes: { starts_at: { type: "timestamp", ops: ["range"], sort: true } },
      references: { listing_id: { collection: "listings", on_delete: "restrict" } },
      unique: [{ fields: ["listing_id", "starts_at"], nulls: "not_distinct" }],
    },
    bookings: {
      kind: "records",
      rules: { list: ["owner", "admin"], get: ["owner", "admin"], create: [], update: [], delete: [] },
      schema: { type: "object", properties: { slot_id: { type: "string", maxLength: 36, format: "uuid" }, note: { type: "string", maxLength: 500 }, status: { type: "string", maxLength: 9, enum: ["booked", "cancelled"] } }, required: ["slot_id", "status"] },
      fields: {},
      indexes: { slot_id: { type: "text", ops: ["eq"], sort: false } },
      references: { slot_id: { collection: "slots", on_delete: "restrict" } },
      unique: [],
      states: { field: "status", values: ["booked", "cancelled"], initial: "booked", transitions: [{ from: "booked", to: "cancelled", principals: ["owner", "admin"] }] },
    },
  },
  actions: {
    reserve_slot: {
      target: { collection: "slots", counter: "booked_count" },
      delta: 1,
      initial: 0,
      bounds: { min: 0, maxField: "capacity" },
      creates: { collection: "bookings", targetField: "slot_id" },
      principals: ["signed_in"],
      idempotency: "required",
      inverse: { name: "cancel_slot", delta: -1, transition: { from: "booked", to: "cancelled" }, principals: ["owner", "admin"], idempotency: "required" },
    },
  },
  aggregates: {
    booking_count: { collection: "bookings", fn: "count", filters: ["slot_id", "status"], principals: ["admin"] },
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyObj = Record<string, any>;
export const v2 = (): AnyObj => JSON.parse(JSON.stringify(KERNEL_V2_EXAMPLE));
