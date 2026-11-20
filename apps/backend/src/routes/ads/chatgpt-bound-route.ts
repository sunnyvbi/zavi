import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { getCampaignBinding } from "@/services/ads-wallet/bindings";
import { withBoundCampaign } from "@/services/ads-wallet/campaign-context";
import { walletError } from "./wallet-auth";

export function chatgptBoundRoute(
  handler: (req: Request, res: Response) => Promise<unknown>,
) {
  return async (req: Request, res: Response) => {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    try {
      const binding = await getCampaignBinding(
        auth.tenant_id,
        z.string().uuid().parse(req.params.bindingId),
      );
      if (binding.platform !== "chatgpt") {
        res.status(404).json({ error: { message: "Campaign not found." } });
        return;
      }
      req.params.campaignId = binding.provider_campaign_id;
      const send = res.json;
      res.json = function (body) {
        if (body?.campaign && !body.snapshot)
          body = {
            ...body,
            campaign: {
              ...body.campaign,
              id: binding.id,
              provider_campaign_id: binding.provider_campaign_id,
            },
          };
        return send.call(this, body);
      };
      try {
        return await withBoundCampaign(binding, () => handler(req, res));
      } finally {
        res.json = send;
      }
    } catch (e) {
      walletError(res, e);
    }
  };
}
