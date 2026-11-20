import type { Request, Response } from "express";
import { requireCreator } from "./auth";
import { affiliateSummary } from "@/services/affiliates/summary";
import { loadCreatorPayoutAccount } from "@/services/creators/db";
import { platformKeyLivemode } from "@/services/creators/client";

export async function getCreatorAffiliate(req: Request, res: Response): Promise<void> {
  const me = await requireCreator(req, res);
  if (!me) return;
  if (me.member.vetting_state !== "approved") {
    res.status(403).json({ error: { code: "not_approved", message: "Your link is ready once your creator profile is approved." } });
    return;
  }
  try {
    let livemode = true;
    try {
      livemode = platformKeyLivemode();
    } catch {
    }
    const summary = await affiliateSummary(me.member_id, livemode);
    let payout = { connected: false, payouts_enabled: false, disconnected: false };
    try {
      const row = await loadCreatorPayoutAccount(me.member_id, platformKeyLivemode());
      if (row) {
        payout = {
          connected: row.details_submitted,
          payouts_enabled: row.payouts_enabled,
          disconnected: row.disabled_reason === "deauthorized",
        };
      }
    } catch {
    }
    res.json({ ...summary, payout });
  } catch (e) {
    console.error(`[affiliate] summary failed: ${(e as Error).message?.slice(0, 200)}`);
    res.status(500).json({ error: { code: "internal", message: "Could not load your affiliate numbers." } });
  }
}
