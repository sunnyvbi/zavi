
import { inngest } from "@/../workers/client";
import type { DeadlineKind } from "./deadline-copy";

export async function armCreatorDeadlineTimer(args: {
  order_id: string;
  tenant_id: string;
  deadline: { kind: DeadlineKind; deadline_at: string };
}): Promise<void> {
  await inngest.send({
    name: "creator/order.deadline.armed",
    data: {
      order_id: args.order_id,
      tenant_id: args.tenant_id,
      deadline_at: args.deadline.deadline_at,
      kind: args.deadline.kind,
    },
  });
}

export async function armCreatorPayoutBufferTimer(args: {
  order_id: string;
  tenant_id: string;
  payout_ready_at: string;
}): Promise<void> {
  await inngest.send({
    name: "creator/order.payout.armed",
    data: {
      order_id: args.order_id,
      tenant_id: args.tenant_id,
      payout_ready_at: args.payout_ready_at,
    },
  });
}

export async function requestCreatorBookingLink(args: { order_id: string; tenant_id: string }): Promise<void> {
  await inngest.send({
    name: "creator/booking.link.requested",
    data: { order_id: args.order_id, tenant_id: args.tenant_id },
  });
}
