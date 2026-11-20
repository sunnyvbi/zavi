import { describe, expect, it, vi } from "vitest";
import type { CreatorOrderStateRow } from "@/services/creators/orders-db";
import type { CreatorOrderStatus } from "@/services/creators/order-state";

import { creatorBookingLinkFn, linkPaidBooking, type BookingLinkIo } from "../creator-booking-link";

vi.mock("../../client", () => ({
  inngest: {
    send: async () => undefined,
    createFunction: (cfg: unknown, trigger: unknown, handler: unknown) => ({ cfg, trigger, handler }),
  },
}));

const TENANT = "11111111-1111-1111-1111-111111111111";
const FORGED_TENANT = "99999999-9999-9999-9999-999999999999";
const ORDER = "0d111111-1111-1111-1111-111111111111";
const CREATOR = "c1111111-1111-1111-1111-111111111111";

function order(over: Partial<CreatorOrderStateRow> = {}): CreatorOrderStateRow {
  return {
    id: ORDER,
    tenant_id: TENANT,
    human_member_id: CREATOR,
    source: "booking",
    status: "in_progress",
    closed_reason: null,
    created_at: "2026-10-01T00:00:00.000Z",
    due_at: null,
    extension_requested_due_at: null,
    extension_state: null,
    next_deadline_at: null,
    next_deadline_kind: null,
    responded_at: null,
    accepted_at: null,
    cancel_requested_at: null,
    status_before_cancel_request: null,
    closed_at: null,
    payout_status: "not_due",
    payout_ready_at: null,
    payout_amount_cents: null,
    price_cents: 15_000,
    business_fee_cents: 1_500,
    creator_fee_cents: 2_250,
    business_total_cents: 16_500,
    creator_payout_cents: 12_750,
    package_snapshot: {},
    livemode: false,
    brief_id: "brief-1",
    application_id: null,
    ...over,
  };
}

function io(row: CreatorOrderStateRow | null, hire: BookingLinkIo["hire"] = async () => "app-1") {
  const hires: Parameters<BookingLinkIo["hire"]>[0][] = [];
  const loads: string[] = [];
  const value: BookingLinkIo = {
    resolveTenant: async (id) => (row && id === row.id ? row.tenant_id : null),
    loadOrder: async (tenant_id, id) => {
      loads.push(tenant_id);
      return row && tenant_id === row.tenant_id && id === row.id ? row : null;
    },
    hire: async (a) => {
      hires.push(a);
      return hire(a);
    },
  };
  return { value, hires, loads };
}

describe("the durable retry of a paid booking's brief link", () => {
  it.each<CreatorOrderStatus>(["in_progress", "submitted", "revision_requested", "cancel_requested", "in_dispute", "completed"])(
    "links a captured booking (%s) using the tenant from the order row",
    async (status) => {
      const t = io(order({ status }));
      expect(await linkPaidBooking(ORDER, t.value)).toEqual({ acted: true, application_id: "app-1" });
      expect(t.loads).toEqual([TENANT]);
      expect(t.hires).toEqual([{ tenant_id: TENANT, brief_id: "brief-1", order_id: ORDER, human_member_id: CREATOR }]);
    },
  );

  it.each<CreatorOrderStatus>(["checkout_pending", "awaiting_acceptance", "cancelled"])(
    "never links a booking that holds no captured money (%s)",
    async (status) => {
      const t = io(order({ status }));
      expect(await linkPaidBooking(ORDER, t.value)).toEqual({ acted: false, reason: "not_captured" });
      expect(t.hires).toEqual([]);
    },
  );

  it("leaves an order that is not a brief booking alone", async () => {
    const applicant = io(order({ source: "applicant" }));
    expect(await linkPaidBooking(ORDER, applicant.value)).toEqual({ acted: false, reason: "not_a_brief_booking" });
    const noBrief = io(order({ brief_id: null }));
    expect(await linkPaidBooking(ORDER, noBrief.value)).toEqual({ acted: false, reason: "not_a_brief_booking" });
    expect([...applicant.hires, ...noBrief.hires]).toEqual([]);
  });

  it("an order that no longer exists is a clean no-op", async () => {
    const t = io(null);
    expect(await linkPaidBooking(ORDER, t.value)).toEqual({ acted: false, reason: "order_gone" });
    expect(t.hires).toEqual([]);
  });

  it("throws while the link keeps failing, so Inngest retries, and the retry that succeeds lands it", async () => {
    let attempts = 0;
    const t = io(order(), async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("brief_applications update timed out");
      return "app-1";
    });
    await expect(linkPaidBooking(ORDER, t.value)).rejects.toThrow(/timed out/);
    await expect(linkPaidBooking(ORDER, t.value)).rejects.toThrow(/timed out/);
    expect(await linkPaidBooking(ORDER, t.value)).toEqual({ acted: true, application_id: "app-1" });
    expect(t.hires).toHaveLength(3);
  });

  it("is registered on the link event with retries and one run per order at a time, and ignores the payload tenant", async () => {
    const fn = creatorBookingLinkFn as unknown as {
      cfg: { id: string; retries: number; concurrency: { key: string; limit: number }[] };
      trigger: { event: string };
      handler: (ctx: { event: { data: unknown }; step: { run: (id: string, f: () => unknown) => unknown } }) => Promise<unknown>;
    };
    expect(fn.trigger).toEqual({ event: "creator/booking.link.requested" });
    expect(fn.cfg.retries).toBeGreaterThanOrEqual(5);
    expect(fn.cfg.concurrency).toEqual([{ key: "event.data.order_id", limit: 1 }]);
    const steps: string[] = [];
    await expect(
      fn.handler({
        event: { data: { order_id: ORDER, tenant_id: FORGED_TENANT } },
        step: {
          run: (id) => {
            steps.push(id);
            return "ran";
          },
        },
      }),
    ).resolves.toBe("ran");
    expect(steps).toEqual(["link"]);
  });
});
