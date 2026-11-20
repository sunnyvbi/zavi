
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { ExpectedToolError } from "@/services/tools/types";
import {
  addManualAdAccount,
  readCurrentAdAccounts,
  selectAdAccount,
  syncAdAccounts,
  type AdAccountsState,
} from "@/services/connectors/tiktok-ads/ad-accounts";
import { tiktokAdsAccount } from "@/services/connectors/tiktok-ads/composio-read";

const CLIENT_ERRORS = new Set([
  "tiktok_ads_bad_account_id",
  "tiktok_ads_account_not_reachable",
  "tiktok_ads_unknown_account",
  "tiktok_ads_not_connected",
]);

const CONFLICTS = new Set(["tiktok_ads_token_revoked", "tiktok_ads_reconnected", "tiktok_ads_accounts_busy"]);

async function respond(res: Response, work: () => Promise<AdAccountsState>): Promise<void> {
  try {
    res.status(200).json(await work());
  } catch (e) {
    if (e instanceof ExpectedToolError) {
      const status = CLIENT_ERRORS.has(e.code) ? 400 : CONFLICTS.has(e.code) ? 409 : 502;
      res.status(status).json({ error: { code: e.code, message: e.message } });
      return;
    }
    res.status(502).json({ error: { code: "tiktok_ads_accounts_failed", message: "We couldn't reach TikTok just now. Try again in a minute." } });
  }
}

export async function tiktokAdAccountsGet(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  await respond(res, () => readCurrentAdAccounts(auth.tenant_id));
}

export async function tiktokAdAccountsRefresh(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  await respond(res, async () => syncAdAccounts(await tiktokAdsAccount(auth.tenant_id)));
}

const SelectBody = z.object({ advertiser_id: z.string().regex(/^\d{1,32}$/) });

export async function tiktokAdAccountsSelect(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const parsed = SelectBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "invalid_input", message: "Pick an ad account from the list." } });
    return;
  }
  await respond(res, () => selectAdAccount(auth.tenant_id, parsed.data.advertiser_id));
}

const ManualBody = z.object({ input: z.string().min(1).max(2000) });

export async function tiktokAdAccountsManual(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const parsed = ManualBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "invalid_input", message: "Paste your Ads Manager link or ad account ID." } });
    return;
  }
  await respond(res, () => addManualAdAccount(auth.tenant_id, parsed.data.input));
}
