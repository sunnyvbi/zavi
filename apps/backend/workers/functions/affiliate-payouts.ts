import { inngest } from "../client";
import { getBoolSetting } from "@/services/settings";
import { alert } from "@/services/logging/alert";
import { requireBillingStripe } from "@/services/billing/client";
import { creatorStripeClient, platformKeyLivemode } from "@/services/creators/client";
import { creatorTransfersActive } from "@/services/creators/payout-accounts";
import { loadCreatorPayoutAccount } from "@/services/creators/db";
import { defaultAffiliateEventDeps, handleAffiliateEvent } from "@/services/affiliates/billing-events";
import { failParkedEvent, parkedEvents, unparkEvent } from "@/services/affiliates/store";
import {
  claimPayout,
  creatorApproved,
  membersToVisit,
  startPayout,
  movePayout,
  openPayouts,
  purgeClicks,
  reversalClaim,
  reversalMove,
  reversalStart,
  runAffiliatePayouts,
} from "@/services/affiliates/payouts";

export const affiliatePayoutsFn = inngest.createFunction(
  { id: "affiliate-payouts", concurrency: 1 },
  { cron: "TZ=America/Los_Angeles 15 9 * * *" },
  async ({ logger }) => {
    const livemode = platformKeyLivemode();
    return runAffiliatePayouts({
      enabled: () => getBoolSetting("affiliate_payouts_enabled"),
      stripe: creatorStripeClient,
      livemode,
      membersToVisit,
      start: startPayout,
      payoutAccount: async (memberId) => {
        const row = await loadCreatorPayoutAccount(memberId, livemode);
        return row ? { stripe_account_id: row.stripe_account_id, disabled_reason: row.disabled_reason ?? null } : null;
      },
      transfersActive: creatorTransfersActive,
      approved: creatorApproved,
      claim: claimPayout,
      move: (id, from, to, transferId, err) => movePayout(id, from, to, transferId ?? null, err ?? null, null),
      openPayouts,
      reversalClaim,
      reversalMove: (id, from, to, stripeId, err) => reversalMove(id, from, to, stripeId ?? null, err ?? null),
      reversalStart,
      purgeClicks,
      drainInbox: async () => {
        let n = 0;
        for (const id of await parkedEvents(500)) {
          try {
            const ev = await requireBillingStripe().events.retrieve(id);
            await handleAffiliateEvent(ev, defaultAffiliateEventDeps(requireBillingStripe));
            await unparkEvent(id);
            n++;
          } catch (e) {
            const { dead } = await failParkedEvent(id, (e as Error)?.message ?? "error");
            if (dead) await alert({ msg: `Affiliate event ${id} failed 5 times and is set aside; its commission or refund is missing until it is replayed.`, source: "affiliate-payouts", code: "affiliate_event_dead" });
          }
        }
        return n;
      },
      alert: (msg) => alert({ msg, source: "affiliate-payouts", code: "affiliate_payout" }),
      log: (m) => logger.warn(m),
      now: () => new Date(),
    });
  },
);

export const affiliateEventRetryFn = inngest.createFunction(
  {
    id: "affiliate-event-retry",
    retries: 10,
    concurrency: { limit: 1, key: "event.data.event_id" },
    onFailure: async ({ event }) => {
      const id = String((event.data as { event?: { data?: { event_id?: unknown } } }).event?.data?.event_id ?? "unknown");
      await alert({ msg: `Affiliate event ${id} could not be applied after 10 retries; its commission or refund is missing until it is replayed.`, source: "affiliate-event-retry", code: "affiliate_event_dead" });
    },
  },
  { event: "affiliate/stripe-event.retry" },
  async ({ event }) => {
    const id = String((event.data as { event_id?: unknown }).event_id ?? "");
    if (!/^evt_[A-Za-z0-9]+$/.test(id)) return { skipped: "bad_event_id" };
    const stripeEvent = await requireBillingStripe().events.retrieve(id);
    return { outcome: await handleAffiliateEvent(stripeEvent, defaultAffiliateEventDeps(requireBillingStripe)) };
  },
);
