import { inngest } from "../client";
import { hireFromBookedBrief } from "@/services/creators/brief-applications";
import { bookingCaptured } from "@/services/creators/briefs-db";
import { loadOrderForState, resolveCreatorOrderTenant } from "@/services/creators/orders-db";

export type BookingLinkIo = {
  resolveTenant: typeof resolveCreatorOrderTenant;
  loadOrder: typeof loadOrderForState;
  hire: (args: { tenant_id: string; brief_id: string; order_id: string; human_member_id: string }) => Promise<string | null>;
};

export const realBookingLinkIo: BookingLinkIo = {
  resolveTenant: resolveCreatorOrderTenant,
  loadOrder: loadOrderForState,
  hire: (args) => hireFromBookedBrief(args),
};

export type BookingLinkOutcome =
  | { acted: false; reason: "order_gone" | "not_a_brief_booking" | "not_captured" }
  | { acted: true; application_id: string | null };

export async function linkPaidBooking(order_id: string, io: BookingLinkIo = realBookingLinkIo): Promise<BookingLinkOutcome> {
  const tenant_id = await io.resolveTenant(order_id);
  if (!tenant_id) return { acted: false, reason: "order_gone" };
  const order = await io.loadOrder(tenant_id, order_id);
  if (!order) return { acted: false, reason: "order_gone" };
  if (order.source !== "booking" || !order.brief_id) return { acted: false, reason: "not_a_brief_booking" };
  if (!bookingCaptured(order.status)) return { acted: false, reason: "not_captured" };
  const application_id = await io.hire({
    tenant_id,
    brief_id: order.brief_id,
    order_id: order.id,
    human_member_id: order.human_member_id,
  });
  return { acted: true, application_id };
}

export const creatorBookingLinkFn = inngest.createFunction(
  {
    id: "creator-booking-link",
    retries: 10,
    concurrency: [{ key: "event.data.order_id", limit: 1 }],
  },
  { event: "creator/booking.link.requested" },
  async ({ event, step }) => {
    const { order_id } = event.data as { order_id: string };
    return step.run("link", () => linkPaidBooking(order_id));
  },
);
