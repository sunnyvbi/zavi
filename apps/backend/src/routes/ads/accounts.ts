import { ExpectedToolError } from "@/services/tools/types";
import type { Request, Response } from "express";
import { z } from "zod";
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { checkAgentTier } from "@/services/agents/entitlement";
import { isChannelLockedStrict } from "@/services/channels/lock";
import { walletAuth as adsAuth, walletError } from "./wallet-auth";
import { requireTenantRole } from "@/services/auth/tenant-role";
import { logEvent } from "@/services/logging/logEvent";
import {
  accountChoices,
  adsPlatform,
  chooseAccount,
  connectCustomerAccount,
  connectChatgptCustomerKey,
  connectManagedAccount,
  customerAccountChoices,
  enableWalletAccount,
  importCustomerCampaign,
} from "@/services/ads-wallet/accounts";
import {
  SHARED_WALLET_CONSENT_TEXT,
  SHARED_WALLET_CONSENT_VERSION,
  sharedWalletConsent,
  autopilotLaunchedOwnBillingCampaigns,
} from "@/services/ads-wallet/consent";

async function authorize(
  req: Request,
  res: Response,
  write = false,
  ownerOrAdmin = true,
) {
  const auth = await adsAuth(req, res, ownerOrAdmin, true);
  if (!auth) return null;
  const platform = adsPlatform.parse(req.params.platform);
  if (write) {
    const tier = await checkAgentTier(auth.tenant_id, `${platform}_ads`);
    if (
      !tier.enforced ||
      !tier.allowed ||
      (await isChannelLockedStrict(`${platform}_ads`))
    ) {
      res.status(403).json({
        error: {
          code: "ads_account_unavailable",
          message: "Account changes are unavailable for this channel.",
        },
      });
      return null;
    }
  }
  return { ...auth, platform };
}
export async function adsAccounts(req: Request, res: Response) {
  try {
    const auth = await authorize(req, res, false, false);
    if (!auth) return;
    const choices = await accountChoices(auth.tenant_id, auth.platform);
    if (auth.platform !== "linkedin") return void res.json(choices);
    const { linkedinChoicesForLogin, linkedinConnectionStamp } = await import("@/services/connectors/linkedin-ads/account-list-cache");
    const connection = await linkedinConnectionStamp(auth.tenant_id);
    res.json({ ...(await linkedinChoicesForLogin(auth.tenant_id, choices)), connection });
  } catch (e) {
    walletError(res, e);
  }
}
export async function adsAvailableAccounts(req: Request, res: Response) {
  try {
    const auth = await authorize(req, res, false, false);
    if (!auth) return;
    if (!(auth as { tenant_overridden?: boolean }).tenant_overridden && !(await requireTenantRole(auth, ["owner", "admin"], res))) return;
    const refresh = req.query?.refresh === "1" || req.query?.refresh === "true";
    res.json(await customerAccountChoices(auth.tenant_id, auth.platform, refresh));
  } catch (e) {
    walletError(res, e);
  }
}
export async function adsConnectAccount(req: Request, res: Response) {
  try {
    const auth = await authorize(req, res, true);
    if (!auth) return;
    const value = z
      .discriminatedUnion("mode", [
        z
          .object({
            mode: z.literal("managed"),
            account_id: z.string().uuid().optional(),
          })
          .strict(),
        z
          .object({
            mode: z.literal("customer"),
            account_id: z.string().min(1).max(200),
          })
          .strict(),
        z
          .object({
            mode: z.literal("customer_key"),
            api_key: z.string().trim().min(10).max(4096),
          })
          .strict(),
      ])
      .parse(req.body);
    if (value.mode === "customer_key" && auth.platform !== "chatgpt") {
      res.status(400).json({
        error: {
          message:
            "API keys are supported only for ChatGPT advertiser accounts.",
        },
      });
      return;
    }
    const id =
      value.mode === "customer_key"
        ? await connectChatgptCustomerKey(auth.tenant_id, value.api_key)
        : value.mode === "managed"
          ? await connectManagedAccount(
              auth.tenant_id,
              auth.platform,
              value.account_id,
            )
          : await connectCustomerAccount(
              auth.tenant_id,
              auth.platform,
              value.account_id,
            );
    res.json({ account_binding_id: id });
  } catch (e) {
    walletError(res, e);
  }
}
export async function adsSelectAccount(req: Request, res: Response) {
  try {
    const auth = await authorize(req, res, true);
    if (!auth) return;
    const value = z
      .object({ account_binding_id: z.string().uuid() })
      .strict()
      .parse(req.body);
    await chooseAccount(
      auth.tenant_id,
      auth.platform,
      value.account_binding_id,
    );
    res.json({ ok: true });
  } catch (e) {
    walletError(res, e);
  }
}
export async function adsDisableAccount(req: Request, res: Response) {
  try {
    const auth = await authorize(req, res);
    if (!auth) return;
    const value = z
      .object({ account_binding_id: z.string().uuid() })
      .strict()
      .parse(req.body);
    const { error } = await tenantRpc(
      asTenantId(auth.tenant_id),
      "ads_disable_account_binding",
      { p_binding_id: value.account_binding_id },
    );
    if (error)
      throw new ExpectedToolError(
        "ads_disable_unavailable",
        "Zavi could not stop using this account just now, so it is still used for new campaigns. Try again in a minute.",
      );
    res.json({ ok: true });
  } catch (e) {
    walletError(res, e);
  }
}
export async function adsEnableAccount(req: Request, res: Response) {
  try {
    const auth = await authorize(req, res);
    if (!auth) return;
    const value = z
      .object({ account_binding_id: z.string().uuid() })
      .strict()
      .parse(req.body);
    const { data, error } = await tenantRpc(
      asTenantId(auth.tenant_id),
      "ads_enable_account_binding",
      { p_binding_id: value.account_binding_id, p_platform: auth.platform },
    );
    if (error) {
      void logEvent({
        level: "error",
        source: "ads-wallet",
        code: "ads_wallet.enable_account_failed",
        tenant_id: auth.tenant_id,
        message: error.message,
        meta: { db_error_code: error.code ?? "unknown" },
      });
      if (error.code === "PGRST202" || error.code === "42883")
        throw new ExpectedToolError(
          "ads_setup_unavailable",
          "Zavi is finishing ad account setup on this server, so Use this account again is unavailable right now. Nothing was changed. Try again later, or pick another account.",
        );
      throw new ExpectedToolError(
        "ads_enable_unavailable",
        "Zavi could not turn this ad account back on just now. Nothing was changed. Try again in a minute, or pick another account.",
      );
    }
    if (data !== true && !(await enableWalletAccount(auth.tenant_id, auth.platform, value.account_binding_id))) {
      res.status(404).json({
        error: {
          code: "ads_account_not_found",
          message: "This ad account cannot be turned back on here. Refresh the page, or connect the account again in Connectors.",
        },
      });
      return;
    }
    res.json({ ok: true, account: (await accountChoices(auth.tenant_id, auth.platform)).accounts.find((a) => a.id === value.account_binding_id) ?? null });
  } catch (e) {
    walletError(res, e);
  }
}
export async function adsImportCampaign(req: Request, res: Response) {
  try {
    const auth = await authorize(req, res, true);
    if (!auth) return;
    const value = z
      .object({
        account_binding_id: z.string().uuid(),
        campaign_id: z.string().min(1).max(200),
      })
      .strict()
      .parse(req.body);
    const binding = await importCustomerCampaign(
      auth.tenant_id,
      value.account_binding_id,
      value.campaign_id,
      auth.platform,
    );
    res.json({ campaign: binding });
  } catch (e) {
    walletError(res, e);
  }
}
const WITHDRAW_PAUSES_NOW = 5;
export async function adsWalletConsent(req: Request, res: Response) {
  const auth = await adsAuth(req, res, req.method === "POST", true);
  if (!auth) return;
  try {
    let saved: boolean | null = null;
    if (req.method === "POST") {
      const value = z
        .object({
          version: z.literal(SHARED_WALLET_CONSENT_VERSION),
          accept: z.boolean(),
        })
        .strict()
        .parse(req.body);
      const { error } = await tenantRpc(
        asTenantId(auth.tenant_id),
        "ads_set_wallet_consent",
        {
          p_actor_user_id: auth.user_id,
          p_version: value.version,
          p_accept: value.accept,
        },
      );
      if (error)
        throw new ExpectedToolError(
          "ads_consent_save_unavailable",
          value.accept
            ? "Zavi could not save your shared wallet permission just now, so it is still not authorized. Try again in a minute."
            : "Zavi could not withdraw your shared wallet permission just now, so it is still authorized and no campaign was paused. Try again in a minute.",
        );
      saved = value.accept;
      if (!value.accept) {
        const { pauseLinkedinBoundCampaign } =
          await import("@/services/ads-wallet/adapters/linkedin");
        const autopilot = await autopilotLaunchedOwnBillingCampaigns(auth.tenant_id).then(
          (ids) => ids,
          () => null,
        );
        const autopilotPauses = await Promise.allSettled(
          (autopilot ?? []).map((id) => pauseLinkedinBoundCampaign(auth.tenant_id, id, true)),
        );
        const autopilotProblem =
          autopilot === null
            ? "Autopilot cannot launch LinkedIn campaigns any more. Zavi could not check which campaigns Autopilot already launched on accounts LinkedIn bills you for directly, so they may still be running. Pause them from your LinkedIn campaign list."
            : autopilotPauses.some((r) => r.status === "rejected")
              ? "Some LinkedIn campaigns Autopilot launched with it are not confirmed paused yet. Zavi will keep trying in the background."
              : null;
        const stopsPending = (wallet: string | null) =>
          new ExpectedToolError(
            "ads_stops_pending",
            ["Your consent is withdrawn.", wallet, autopilotProblem].filter(Boolean).join(" "),
          );
        const rows = await tenantClient(asTenantId(auth.tenant_id))
          .from("ads_campaign_pending_stops")
          .select("campaign_binding_id")
          .eq("funding_source", "wallet")
          .range(0, 999);
        if (
          rows.error ||
          !Array.isArray(rows.data) ||
          rows.data.length === 1000
        )
          throw stopsPending("Zavi could not check which LinkedIn campaigns it pays for just now, and will keep pausing them in the background.");
        const ids = (rows.data as Array<{ campaign_binding_id: string }>).map((r) => r.campaign_binding_id);
        const ended = ids.length
          ? await tenantClient(asTenantId(auth.tenant_id))
              .from("ads_campaign_spend_stability")
              .select("campaign_binding_id")
              .not("ended_since", "is", null)
              .range(0, 999)
              .then(
                (r) => new Set(r.error || !Array.isArray(r.data) ? [] : (r.data as Array<{ campaign_binding_id: string }>).map((e) => e.campaign_binding_id)),
                () => new Set<string>(),
              )
          : new Set<string>();
        const spendable = ids.filter((id) => !ended.has(id));
        let unconfirmed = spendable.length > WITHDRAW_PAUSES_NOW;
        for (const id of spendable.slice(0, WITHDRAW_PAUSES_NOW)) {
          try {
            await pauseLinkedinBoundCampaign(auth.tenant_id, id, false);
          } catch {
            unconfirmed = true;
          }
        }
        if (unconfirmed)
          throw stopsPending("Some LinkedIn campaigns Zavi pays for are not confirmed paused yet. Zavi will keep trying in the background.");
        if (autopilotProblem) throw stopsPending(null);
      }
    }
    res.json({
      version: SHARED_WALLET_CONSENT_VERSION,
      text: SHARED_WALLET_CONSENT_TEXT,
      accepted: saved ?? (await sharedWalletConsent(auth.tenant_id)),
    });
  } catch (e) {
    walletError(res, e);
  }
}
export async function adsWalletReservations(req: Request, res: Response) {
  const auth = await adsAuth(req, res, false, true);
  if (!auth) return;
  try {
    const rows: unknown[] = [];
    for (let start = 0; start < 50_000; start += 500) {
      const { data, error } = await tenantClient(asTenantId(auth.tenant_id))
        .from("ads_wallet_reservation_details")
        .select(
          "campaign_binding_id,provider_campaign_id,platform,provider_account_id,funding_source,reserved_cents,spent_cents",
        )
        .order("campaign_binding_id")
        .range(start, start + 499);
      if (error || !Array.isArray(data))
        throw new Error("Could not read reservations");
      rows.push(...data);
      if (data.length < 500) {
        res.json({ reservations: rows });
        return;
      }
    }
    throw new Error("Incomplete reservation read");
  } catch (e) {
    walletError(res, e);
  }
}
