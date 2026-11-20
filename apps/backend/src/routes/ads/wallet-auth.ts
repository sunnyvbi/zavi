import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import { refillEligibility } from "@/services/ads-wallet/providers";
import { ExpectedToolError } from "@/services/tools/types";
import { logEvent } from "@/services/logging/logEvent";

export async function walletAuth(req: Request, res: Response, write = false, allowUnavailable = false) {
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return null;
    if (write && (auth as { tenant_overridden?: boolean }).tenant_overridden) {
      res.status(403).json({ error: { code: "tenant_override_forbidden", message: "Switch to your own workspace to make changes." } }); return null;
    }
    if (write && !(await requireTenantRole(auth, ["owner", "admin"], res))) return null;
    if (!allowUnavailable && await refillEligibility(auth.tenant_id) !== "allowed") {
      res.status(403).json({ error: { code: "channel_unavailable", message: "Ads funding is not available for this workspace." } }); return null;
    }
    return auth;
  } catch {
    res.status(503).json({ error: { code: "authorization_unavailable", message: "Workspace access could not be checked. Try again." } }); return null;
  }
}
export function walletError(res: Response, error: unknown) {
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: { code: "bad_request", message: "Check the request fields and try again." } }); return;
  }
  const code = error instanceof ExpectedToolError ? error.code : "chatgpt_ads_unavailable";
  if (!(error instanceof ExpectedToolError)) void logEvent({ level: "error", source: "ads-wallet", code: "ads_wallet.unexpected_error", message: error instanceof Error ? error.message : String(error) });
  const status = code === "chatgpt_ads_not_found" ? 404
    : code === "ads_account_read_only" || code === "linkedin_ads_writes_off" || code === "linkedin_ads_token_revoked" || code === "linkedin_ads_forbidden" ? 403
    : ["ads_launch_conflict","ads_launch_not_sent","ads_account_mismatch","ads_campaign_mismatch","ads_account_unsupported","ads_currency_unsupported","ads_consent_required","ads_connection_required","ads_stops_pending","ads_account_disabled","ads_account_owned_elsewhere"].includes(code) ? 409
    : ["ads_credentials_unavailable","ads_accounts_unavailable","ads_consent_unavailable","ads_binding_unavailable","ads_pause_queued","ads_setup_unavailable","ads_enable_unavailable","ads_disable_unavailable","ads_consent_save_unavailable"].includes(code) ? 503
    : code === "chatgpt_ads_conflict" || code === "ads_balance_insufficient" ? 409
    : code === "chatgpt_ads_card_declined" ? 402
    : code.startsWith("chatgpt_ads_card_") ? 400 : 502;
  const wire = code === "ads_launch_conflict" && error instanceof ExpectedToolError && error.meta?.outcome_unknown === true ? "linkedin_launch_outcome_unknown" : code;
  res.status(status).json({ error: { code: wire, message: error instanceof ExpectedToolError ? error.message : "The request could not be completed. Refresh before trying again." } });
}
