import { z } from "zod";
import { ExpectedToolError, type ToolSpec } from "@/services/tools/types";
import { bookingBriefSnapshot, quoteCreatorBooking, startCreatorCheckout, type BookingTarget } from "@/services/creators/booking";
import { declineCreatorHire, fileCreatorHireCard } from "@/services/creators/hire-card";
import { assertWithinHireCap, onCreatorChannel, usd } from "./shared";

export const CREATOR_BOOK_CLASS = "creator.hire";

const inputSchema = z.object({
  package_id: z.string().uuid().describe("The creator package to book, from the creator's listed packages."),
  brief: z.string().trim().max(4000).optional().describe("A short brief for the creator: what to film or post and the angle."),
});

type Filed = { card_id: string; total_cents: number; price_cents: number; fee_cents: number; creator_name: string };

export const creatorBookPackageTool: ToolSpec = {
  name: "creator_book_package",
  effect: "write",
  description:
    "Propose booking one of an approved creator's packages. Files a hire card with the full cost; nothing is charged until the founder approves it, and declining it cancels the order. Refused when it would exceed the per-hire cap.",
  input_schema: inputSchema,
  async execute(ctx, rawInput) {
    const input = inputSchema.parse(rawInput);
    const target: BookingTarget = { source: "booking", package_id: input.package_id };
    const out = await onCreatorChannel<Filed>(ctx, CREATOR_BOOK_CLASS, "creator_book_wrong_run", async ({ tenant_id, run_id }) => {
      const quote = await quoteCreatorBooking({ tenant_id, target });
      if (quote.blocked) throw new ExpectedToolError(quote.blocked.code, quote.blocked.message);
      if (!quote.creator.payout_supported) {
        throw new ExpectedToolError("creator_not_hireable", "Zavi cannot pay this creator yet, so they cannot be booked. Nothing was created.");
      }
      await assertWithinHireCap(tenant_id, quote.money.price_cents);
      const checkout = await startCreatorCheckout({
        tenant_id,
        user_id: null,
        target,
        initiator: "agent",
        agent_run_id: run_id,
        brief_snapshot_override: bookingBriefSnapshot({ title: quote.job.title, brief: input.brief ?? null }),
      });
      const money = checkout.quote.money;
      const args = {
        tenant_id,
        run_id,
        order_id: checkout.order_id,
        creator_name: checkout.quote.creator.display_name,
        package_title: checkout.quote.job.title,
        business_total_cents: money.business_total_cents,
        price_cents: money.price_cents,
        fee_cents: money.business_fee_cents,
      };
      let card: Awaited<ReturnType<typeof fileCreatorHireCard>>;
      try {
        card = await fileCreatorHireCard(args);
      } catch (e) {
        await declineCreatorHire({ tenant_id, order_id: checkout.order_id, reason: "hire card could not be filed" });
        throw e;
      }
      if (!card.ok) {
        await declineCreatorHire({ tenant_id, order_id: checkout.order_id, reason: card.message });
        throw new ExpectedToolError(`creator_${card.refusal}`, `${card.message} The order was cancelled and nothing was charged.`);
      }
      return {
        card_id: card.card_id,
        total_cents: money.business_total_cents,
        price_cents: money.price_cents,
        fee_cents: money.business_fee_cents,
        creator_name: args.creator_name,
      };
    });
    if (out.suppressed) return { filed: false, note: "Draft run: nothing was booked." };
    const r = out.result;
    return {
      filed: true,
      action_id: r.card_id,
      note: `Filed a hire card for ${usd(r.total_cents)} (${usd(r.price_cents)} + ${usd(r.fee_cents)} Zavi fee) to book ${r.creator_name}; the founder approves it. Nothing is charged until then.`,
    };
  },
};
