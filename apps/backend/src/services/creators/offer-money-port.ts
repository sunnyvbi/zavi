
import { startCreatorCheckout } from "./booking";
import { businessJobReturnPaths } from "./hub-links";
import {
  registerCreatorMoneyPort,
  type CreatorMoneyPort,
  type PlaceHoldForOfferResult,
} from "./money-port";

export function offerReturnUrls(): { success_url: string; cancel_url: string } {
  const origin = (process.env.WEB_ORIGIN || "https://www.zaviagent.com")
    .split(",")[0]
    .trim()
    .replace(/\/+$/, "");
  const back = businessJobReturnPaths("{ORDER_ID}");
  return {
    success_url: `${origin}${back.success}`,
    cancel_url: `${origin}${back.cancel}`,
  };
}

export const realCreatorOfferMoneyPort: CreatorMoneyPort = {
  async placeHoldForOffer(input): Promise<PlaceHoldForOfferResult> {
    if (input.initiator === "agent") {
      const held = await startCreatorCheckout({
        tenant_id: input.tenant_id,
        user_id: null,
        target: { source: "offer", offer_id: input.offer_id },
        initiator: "agent",
        agent_run_id: input.agent_run_id ?? null,
        offer_already_claimed: true,
      });
      return {
        order_id: held.order_id,
        status: "checkout_pending",
        already_existed: held.reused_existing,
        checkout_url: null,
      };
    }
    const urls = offerReturnUrls();
    const started = await startCreatorCheckout({
      tenant_id: input.tenant_id,
      user_id: null,
      target: { source: "offer", offer_id: input.offer_id },
      large_amount_confirmed: true,
      success_url: urls.success_url,
      cancel_url: urls.cancel_url,
      offer_already_claimed: true,
    });
    return {
      order_id: started.order_id,
      status: "checkout_pending",
      already_existed: started.reused_existing,
      checkout_url: started.checkout_url,
    };
  },
};

export function wireCreatorMoneyPort(): void {
  registerCreatorMoneyPort(realCreatorOfferMoneyPort);
}
