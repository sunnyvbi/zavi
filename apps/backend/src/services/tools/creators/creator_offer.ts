import { z } from "zod";
import { ExpectedToolError, type ToolSpec } from "@/services/tools/types";
import { createCreatorOffer, openAgentOfferExists } from "@/services/creators/offers";
import { computeCreatorFees } from "@/services/creators/order-fees";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { assertWithinHireCap, assertWithinOutreachCap, loadHireableCreator, onCreatorChannel, usd } from "./shared";

export const CREATOR_OFFER_CLASS = "creator.offer";

const RUN_MEMBER_KEY = "creator_offers_agent_run_member_key";

type SentOffer = { offer_id: string; creator_name: string; total_cents: number; already_sent: boolean };

async function offerFromThisRun(tenant_id: string, run_id: string, human_member_id: string): Promise<{ id: string; price_cents: number } | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("creator_offers")
    .select("id, price_cents")
    .eq("agent_run_id", run_id)
    .eq("human_member_id", human_member_id)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`creator_offers read failed: ${error.message}`);
  return (data as { id: string; price_cents: number } | null) ?? null;
}

function alreadySent(row: { id: string; price_cents: number }, creator_name: string): SentOffer {
  return { offer_id: row.id, creator_name, total_cents: computeCreatorFees(row.price_cents).business_total_cents, already_sent: true };
}

const inputSchema = z.object({
  human_member_id: z.string().uuid().describe("The creator, from growth__search_human_members (bookable=true)."),
  kind: z.enum(["ugc_video"]).describe("ugc_video = a video the business runs itself as an ad. It is the only kind of creator job Zavi sells."),
  title: z.string().trim().min(1).max(200).describe("What is being bought, in a few words, e.g. '2 product demo videos'."),
  description: z.string().trim().min(1).max(2000).describe("The deliverable: what to film or post, length, format and usage rights."),
  price_usd: z.number().positive().max(100000).describe("The creator's price in USD, before the Zavi fee."),
  delivery_days: z.number().int().min(1).max(90).describe("Days the creator has to deliver."),
  product_needed: z.boolean().optional().describe("True when the business must ship the creator a product first."),
});

export const creatorOfferTool: ToolSpec = {
  name: "creator_offer",
  effect: "write",
  description:
    "Send an approved Zavi creator a custom offer from the business. Nothing is charged: if the creator accepts, a hire card is filed and the founder approves or declines it. Refused when it would exceed the per-hire cap.",
  input_schema: inputSchema,
  async execute(ctx, rawInput) {
    const input = inputSchema.parse(rawInput);
    const price_cents = Math.round(input.price_usd * 100);
    const out = await onCreatorChannel<SentOffer>(ctx, CREATOR_OFFER_CLASS, "creator_offer_wrong_run", async ({ tenant_id, run_id }) => {
      const creator = await loadHireableCreator(input.human_member_id);
      const earlier = await offerFromThisRun(tenant_id, run_id, creator.id);
      if (earlier) return alreadySent(earlier, creator.display_name);
      const fees = await assertWithinHireCap(tenant_id, price_cents);
      await assertWithinOutreachCap(tenant_id);
      if (await openAgentOfferExists(tenant_id, creator.id)) {
        throw new ExpectedToolError(
          "creator_offer_already_open",
          `${creator.display_name} already has an open offer from this business. Wait for their answer before sending another.`,
        );
      }
      let offer: { id: string };
      try {
        offer = await createCreatorOffer({
          tenant_id,
          human_member_id: creator.id,
          proposed_by: "tenant",
          proposed_by_user_id: null,
          agent_run_id: run_id,
          kind: input.kind,
          terms: { title: input.title, description: input.description },
          price_cents,
          delivery_days: input.delivery_days,
          product_needed: input.product_needed === true,
        });
      } catch (e) {
        if (!(e instanceof Error) || !e.message.includes(RUN_MEMBER_KEY)) throw e;
        const raced = await offerFromThisRun(tenant_id, run_id, creator.id);
        if (!raced) throw e;
        return alreadySent(raced, creator.display_name);
      }
      return { offer_id: offer.id, creator_name: creator.display_name, total_cents: fees.business_total_cents, already_sent: false };
    });
    if (out.suppressed) return { offered: false, note: "Draft run: nothing was sent." };
    if (out.result.already_sent) {
      return {
        offered: true,
        offer_id: out.result.offer_id,
        already_sent: true,
        note: `This run already sent ${out.result.creator_name} an offer for ${usd(out.result.total_cents)} with the Zavi fee. Nothing new was sent.`,
      };
    }
    return {
      offered: true,
      offer_id: out.result.offer_id,
      note: `Offer sent to ${out.result.creator_name} for ${usd(out.result.total_cents)} with the Zavi fee. Nothing is charged; if they accept, the founder approves the hire.`,
    };
  },
};
