
import {
  listCreatorPayoutsAwaiting,
  markCreatorPayoutReady,
  type CreatorMoneyEventCause,
} from "./db";
import { transferToCreator } from "./orders-money";

export const MAX_PAYOUT_RELEASES = 10;

export function payoutCauseForClose(
  closed_reason: string | null,
): Extract<CreatorMoneyEventCause, "approval" | "auto_accept_buffer" | "mediation"> | null {
  switch (closed_reason) {
    case "approved":
      return "approval";
    case "auto_accepted":
      return "auto_accept_buffer";
    case "mediation_pay_full":
    case "mediation_pay_part":
      return "mediation";
    default:
      return null;
  }
}

export type PayoutReleaseResult = {
  released: number;
  still_waiting: number;
  rejected: { order_id: string; tenant_id: string; reason: string }[];
};

export type PayoutReleaseDeps = {
  listPayoutsAwaiting: typeof listCreatorPayoutsAwaiting;
  markPayoutReady: typeof markCreatorPayoutReady;
  transfer: typeof transferToCreator;
};

export const realPayoutReleaseDeps: PayoutReleaseDeps = {
  listPayoutsAwaiting: listCreatorPayoutsAwaiting,
  markPayoutReady: markCreatorPayoutReady,
  transfer: transferToCreator,
};

export async function releaseParkedPayouts(
  human_member_id: string,
  livemode: boolean,
  deps: PayoutReleaseDeps,
): Promise<PayoutReleaseResult> {
  const waiting = await deps.listPayoutsAwaiting(human_member_id, livemode, MAX_PAYOUT_RELEASES);
  let released = 0;
  let stillWaiting = 0;
  const rejected: PayoutReleaseResult["rejected"] = [];
  for (const order of waiting) {
    const cause = payoutCauseForClose(order.closed_reason);
    if (!cause) {
      stillWaiting += 1;
      continue;
    }
    if (order.payout_status === "awaiting_payout_account") {
      await deps.markPayoutReady({
        tenant_id: order.tenant_id,
        order_id: order.id,
        payout_ready_at: order.payout_ready_at,
      });
    }
    const result = await deps.transfer({ tenant_id: order.tenant_id, order_id: order.id, cause });
    if (result.ok) {
      released += 1;
    } else {
      stillWaiting += 1;
      rejected.push({ order_id: order.id, tenant_id: order.tenant_id, reason: result.reason });
    }
  }
  return { released, still_waiting: stillWaiting, rejected };
}
