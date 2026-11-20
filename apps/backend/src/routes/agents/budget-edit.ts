
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { serviceClient } from "@/services/supabase";
import { isMetaAdsWriteEnabled } from "@/services/tools/meta-ads/write/_flag-check";
import { isGoogleAdsWriteEnabled } from "@/services/tools/google-ads/write/_flag-check";
import { gadsGetCampaignBudget } from "@/services/tools/google-ads/_client";
import { GOOGLE_NON_USD_CODE, readGoogleAccountCurrency } from "@/services/tools/google-ads/write/_currency-guard";
import {
  enumerateCampaignAdSets,
  classifyCampaignBudgeting,
} from "@/services/tools/meta-ads/list_ad_sets";
import { fbGet, getAdAccountCurrency } from "@/services/tools/meta-ads/_client";
import { AUTHORIZED_EFFECTIVE_CAP } from "@/services/tools/meta-ads/write/_user-initiated";
import {
  formatMoney,
  isWritableCurrency,
  minorToMajor,
  normalizeCurrency,
} from "@/services/tools/meta-ads/write/_currency";
import { unitsPerUsd } from "@/services/tools/meta-ads/write/_fx-rate";

const MAX_DAILY_BUDGET_USD = 10_000;

const BudgetBodySchema = z
  .object({
    channel: z.enum(["meta", "google"]).default("meta"),
    campaign_id: z.string().min(1).max(64),
    campaign_name: z.string().trim().max(200).optional(),
    proposed_daily_budget_usd: z.number().positive().finite(),
  })
  .superRefine((value, ctx) => {
    if (value.channel === "google" && !/^\d+$/.test(value.campaign_id)) {
      ctx.addIssue({
        code: "custom",
        path: ["campaign_id"],
        message: "Google Ads campaign_id must be numeric.",
      });
    }
  });

const PauseBodySchema = z.object({
  campaign_id: z.string().min(1).max(64),
});

const CampaignStatusBodySchema = z
  .object({
    channel: z.enum(["meta", "google"]),
    campaign_id: z.string().min(1).max(128),
    campaign_name: z.string().trim().max(200).optional(),
    enabled: z.boolean(),
  })
  .superRefine((value, ctx) => {
    if (value.channel === "google" && !/^\d+$/.test(value.campaign_id)) {
      ctx.addIssue({
        code: "custom",
        path: ["campaign_id"],
        message: "Google Ads campaign_id must be numeric.",
      });
    }
  });

type ResolvedAdSet = {
  ad_set_id: string;
  ad_set_name?: string;
  daily_budget_usd: number;
  currency: string;
};

async function passesWriteFlagGate(res: Response): Promise<boolean> {
  if (!(await isMetaAdsWriteEnabled())) {
    res.status(409).json({
      error: {
        code: "meta_ads_write_disabled",
        message:
          "Meta Ads changes are disabled at the platform level. Ask the agent in chat or contact support to enable.",
      },
    });
    return false;
  }
  return true;
}

type ResolvedCampaign = {
  campaign_name?: string;
  daily_budget_usd: number;
  currency: string;
};

async function resolveCampaignBudget(
  res: Response,
  campaign_id: string,
  tenant_id: string,
): Promise<ResolvedCampaign | "ad_sets" | null> {
  let c: { name?: string; daily_budget?: string | null; lifetime_budget?: string | null };
  try {
    c = (await fbGet(tenant_id, campaign_id, { fields: "name,daily_budget,lifetime_budget" })) as typeof c;
  } catch (e) {
    res.status(502).json({
      error: {
        code: "ad_sets_unavailable",
        message: `Couldn't read this campaign from Meta (${(e as Error).message}). Try again, or ask the agent in chat.`,
      },
    });
    return null;
  }
  if (Number(c.lifetime_budget ?? 0) > 0) {
    res.status(409).json({
      error: {
        code: "lifetime_budget",
        message: "This campaign has a lifetime budget. Zavi changes daily budgets only; change it in Meta Ads Manager.",
      },
    });
    return null;
  }
  if (!(Number(c.daily_budget ?? 0) > 0)) return "ad_sets";
  let currency: string;
  try {
    currency = await getAdAccountCurrency(tenant_id);
  } catch (e) {
    res.status(502).json({
      error: {
        code: "ad_sets_unavailable",
        message: `Couldn't read this account's currency from Meta (${(e as Error).message}). Try again, or ask the agent in chat.`,
      },
    });
    return null;
  }
  if (!isWritableCurrency(currency)) {
    res.status(409).json({
      error: {
        code: "unsupported_currency",
        message: `Budget edits from the Ads Manager support USD and INR ad accounts only (this account is ${currency}). Ask the agent in chat.`,
      },
    });
    return null;
  }
  const current = minorToMajor(c.daily_budget ?? null, currency);
  if (current == null || !(current > 0)) {
    res.status(409).json({
      error: { code: "ambiguous_target", message: "Couldn't read this campaign's daily budget. Ask the agent in chat to change it." },
    });
    return null;
  }
  return {
    ...(c.name ? { campaign_name: c.name } : {}),
    daily_budget_usd: current,
    currency: normalizeCurrency(currency),
  };
}

async function resolveBudgetTargetAdSet(
  res: Response,
  campaign_id: string,
  tenant_id: string,
): Promise<ResolvedAdSet | null> {
  let adSets: Awaited<ReturnType<typeof enumerateCampaignAdSets>>;
  try {
    adSets = await enumerateCampaignAdSets(tenant_id, campaign_id);
  } catch (e) {
    res.status(502).json({
      error: {
        code: "ad_sets_unavailable",
        message: `Couldn't read this campaign's ad sets from Meta (${(e as Error).message}). Try again, or ask the agent in chat.`,
      },
    });
    return null;
  }

  const cls = classifyCampaignBudgeting(adSets);
  if (cls.kind !== "single") {
    res.status(409).json({
      error: {
        code: "ambiguous_target",
        message:
          cls.kind === "cbo_or_none"
            ? "No ad set in this campaign has its own daily budget. Ask the agent in chat to change it."
            : "This campaign has multiple ad sets with their own budgets. Ask the agent in chat which one to change.",
      },
    });
    return null;
  }

  let currency: string;
  try {
    currency = await getAdAccountCurrency(tenant_id);
  } catch (e) {
    res.status(502).json({
      error: {
        code: "ad_sets_unavailable",
        message: `Couldn't read this account's currency from Meta (${(e as Error).message}). Try again, or ask the agent in chat.`,
      },
    });
    return null;
  }
  if (!isWritableCurrency(currency)) {
    res.status(409).json({
      error: {
        code: "unsupported_currency",
        message: `Budget edits from the Ads Manager support USD and INR ad accounts only (this account is ${currency}). Ask the agent in chat.`,
      },
    });
    return null;
  }

  const current = minorToMajor(cls.adSet.daily_budget ?? null, currency);
  if (current == null || !(current > 0)) {
    res.status(409).json({
      error: {
        code: "ambiguous_target",
        message:
          "Couldn't read this ad set's current daily budget. Ask the agent in chat to change it.",
      },
    });
    return null;
  }

  return {
    ad_set_id: cls.adSet.id!,
    ...(cls.adSet.name ? { ad_set_name: cls.adSet.name } : {}),
    daily_budget_usd: current,
    currency: normalizeCurrency(currency),
  };
}

export async function performanceMarketerBudgetEdit(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const parsed = BudgetBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: "invalid_body",
        message: parsed.error.issues.map((i) => i.message).join("; "),
      },
    });
    return;
  }
  const { channel, campaign_id, campaign_name, proposed_daily_budget_usd } = parsed.data;

  if (channel === "google") {
    if (proposed_daily_budget_usd > MAX_DAILY_BUDGET_USD) {
      res.status(400).json({
        error: { code: "invalid_body", message: `A daily budget above ${formatMoney(MAX_DAILY_BUDGET_USD, "USD")} looks like a typo.` },
      });
      return;
    }
    await stageGoogleBudgetEdit(res, auth.tenant_id, {
      campaign_id,
      campaign_name,
      proposed_daily_budget_usd,
    });
    return;
  }

  if (!(await passesWriteFlagGate(res))) return;

  const campaignBudget = await resolveCampaignBudget(res, campaign_id, auth.tenant_id);
  if (campaignBudget === null) return;
  if (campaignBudget !== "ad_sets") {
    await stageMetaCampaignBudgetEdit(res, auth.tenant_id, campaign_id, campaignBudget, proposed_daily_budget_usd);
    return;
  }

  const adSet = await resolveBudgetTargetAdSet(res, campaign_id, auth.tenant_id);
  if (!adSet) return;

  const expected_current_daily_budget_usd = adSet.daily_budget_usd;

  let ceiling: number;
  try {
    ceiling = MAX_DAILY_BUDGET_USD * (await unitsPerUsd(adSet.currency));
  } catch (e) {
    res.status(502).json({
      error: { code: "ad_sets_unavailable", message: `Couldn't check this budget (${(e as Error).message}). Try again.` },
    });
    return;
  }
  if (proposed_daily_budget_usd > ceiling) {
    res.status(400).json({
      error: { code: "invalid_body", message: `A daily budget above ${formatMoney(ceiling, adSet.currency)} looks like a typo.` },
    });
    return;
  }

  const body = {
    ad_set_id: adSet.ad_set_id,
    daily_budget_usd: proposed_daily_budget_usd,
    expected_current_daily_budget_usd,
    currency: adSet.currency,
    rationale: "Budget change requested by the operator from the Ads Manager.",
    over_cap: true,
    origin: "user_initiated_ledger" as const,
    authorized_effective_cap: AUTHORIZED_EFFECTIVE_CAP,
    ...(adSet.ad_set_name ? { name: adSet.ad_set_name } : {}),
    about: "Operator-initiated daily-budget change.",
    campaign_id,
  };

  try {
    const { data, error } = await serviceClient().rpc("emit_decision", {
      p_tenant_id: auth.tenant_id,
      p_agent_run_id: null,
      p_decision_class: "meta_ads.update_ad_set_budget_review",
      p_body: body as object,
    });
    if (error) {
      res.status(500).json({
        error: { code: "emit_failed", message: "Couldn't stage the change." },
      });
      return;
    }
    if (!(await stagedDecisionMatches(auth.tenant_id, data as string, { key: "ad_set_id", id: adSet.ad_set_id, daily_budget_usd: proposed_daily_budget_usd }))) {
      res.status(409).json(DIFFERENT_CHANGE_OPEN);
      return;
    }
    res.json({
      ok: true,
      decision_id: data as string,
      ad_set_id: adSet.ad_set_id,
      ad_set_name: adSet.ad_set_name ?? null,
      current_daily_budget_usd: expected_current_daily_budget_usd,
      proposed_daily_budget_usd,
      currency: adSet.currency,
    });
  } catch (e) {
    res.status(500).json({
      error: {
        code: "emit_failed",
        message: `Couldn't stage the change (${(e as Error).message}).`,
      },
    });
  }
}

async function stageMetaCampaignBudgetEdit(
  res: Response,
  tenant_id: string,
  campaign_id: string,
  campaign: ResolvedCampaign,
  proposed_daily_budget_usd: number,
): Promise<void> {
  let ceiling: number;
  try {
    ceiling = MAX_DAILY_BUDGET_USD * (await unitsPerUsd(campaign.currency));
  } catch (e) {
    res.status(502).json({
      error: { code: "ad_sets_unavailable", message: `Couldn't check this budget (${(e as Error).message}). Try again.` },
    });
    return;
  }
  if (proposed_daily_budget_usd > ceiling) {
    res.status(400).json({
      error: { code: "invalid_body", message: `A daily budget above ${formatMoney(ceiling, campaign.currency)} looks like a typo.` },
    });
    return;
  }
  const body = {
    campaign_id,
    daily_budget_usd: proposed_daily_budget_usd,
    expected_current_daily_budget_usd: campaign.daily_budget_usd,
    currency: campaign.currency,
    rationale: "Budget change requested by the operator from the Ads Manager.",
    over_cap: true,
    origin: "user_initiated_ledger" as const,
    authorized_effective_cap: AUTHORIZED_EFFECTIVE_CAP,
    ...(campaign.campaign_name ? { name: campaign.campaign_name } : {}),
    about: "Operator-initiated campaign daily-budget change.",
  };
  try {
    const { data, error } = await serviceClient().rpc("emit_decision", {
      p_tenant_id: tenant_id,
      p_agent_run_id: null,
      p_decision_class: "meta_ads.update_campaign_budget_review",
      p_body: body as object,
    });
    if (error) {
      res.status(500).json({ error: { code: "emit_failed", message: "Couldn't stage the change." } });
      return;
    }
    if (!(await stagedDecisionMatches(tenant_id, data as string, { key: "campaign_id", id: campaign_id, daily_budget_usd: body.daily_budget_usd }))) {
      res.status(409).json(DIFFERENT_CHANGE_OPEN);
      return;
    }
    res.json({
      ok: true,
      decision_id: data as string,
      level: "campaign",
      campaign_id,
      campaign_name: campaign.campaign_name ?? null,
      current_daily_budget_usd: campaign.daily_budget_usd,
      proposed_daily_budget_usd,
      currency: campaign.currency,
    });
  } catch (e) {
    res.status(500).json({
      error: { code: "emit_failed", message: `Couldn't stage the change (${(e as Error).message}).` },
    });
  }
}

async function refuseNonUsdGoogle(res: Response, tenant_id: string): Promise<boolean> {
  let currency: string;
  try {
    currency = await readGoogleAccountCurrency(tenant_id);
  } catch (e) {
    res.status(502).json({
      error: {
        code: "google_ads_currency_unverified",
        message: `Couldn't read this Google Ads account's currency (${(e as Error).message}). Nothing was staged; try again.`,
      },
    });
    return true;
  }
  if (currency === "USD") return false;
  res.status(409).json({
    error: {
      code: GOOGLE_NON_USD_CODE,
      message: `This Google Ads account bills in ${currency || "an unknown currency"}. Zavi changes Google budgets in USD only, so nothing was staged.`,
    },
  });
  return true;
}

async function stageGoogleBudgetEdit(
  res: Response,
  tenant_id: string,
  input: { campaign_id: string; campaign_name?: string; proposed_daily_budget_usd: number },
): Promise<void> {
  if (!(await isGoogleAdsWriteEnabled())) {
    res.status(409).json({
      error: {
        code: "google_ads_write_disabled",
        message: "Google Ads changes are disabled at the platform level. Ask the agent in chat or contact support to enable.",
      },
    });
    return;
  }
  if (await refuseNonUsdGoogle(res, tenant_id)) return;
  let live: Awaited<ReturnType<typeof gadsGetCampaignBudget>>;
  try {
    live = await gadsGetCampaignBudget(tenant_id, input.campaign_id);
  } catch (e) {
    res.status(502).json({
      error: {
        code: "campaign_unavailable",
        message: `Couldn't read this campaign's budget from Google Ads (${(e as Error).message}). Try again, or ask the agent in chat.`,
      },
    });
    return;
  }
  const expected_current_daily_budget_usd = live.amount_micros / 1_000_000;
  const body = {
    campaign_id: input.campaign_id,
    daily_budget_usd: input.proposed_daily_budget_usd,
    expected_current_daily_budget_usd,
    rationale: "Budget change requested by the operator from the Ads Manager.",
    over_cap: true,
    ...(input.campaign_name ? { name: input.campaign_name } : {}),
    about: "Operator-initiated daily-budget change.",
    origin: "user_initiated_ledger" as const,
  };
  try {
    const { data, error } = await serviceClient().rpc("emit_decision", {
      p_tenant_id: tenant_id,
      p_agent_run_id: null,
      p_decision_class: "google_ads.update_campaign_budget_review",
      p_body: body as object,
    });
    if (error) {
      res.status(500).json({
        error: { code: "emit_failed", message: "Couldn't stage the change." },
      });
      return;
    }
    if (!(await stagedDecisionMatches(tenant_id, data as string, { key: "campaign_id", id: input.campaign_id, daily_budget_usd: input.proposed_daily_budget_usd }))) {
      res.status(409).json(DIFFERENT_CHANGE_OPEN);
      return;
    }
    res.json({
      ok: true,
      decision_id: data as string,
      campaign_id: input.campaign_id,
      current_daily_budget_usd: expected_current_daily_budget_usd,
      proposed_daily_budget_usd: input.proposed_daily_budget_usd,
    });
  } catch (e) {
    res.status(500).json({
      error: {
        code: "emit_failed",
        message: `Couldn't stage the change (${(e as Error).message}).`,
      },
    });
  }
}

export async function performanceMarketerPause(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const parsed = PauseBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: "invalid_body",
        message: parsed.error.issues.map((i) => i.message).join("; "),
      },
    });
    return;
  }
  const { campaign_id } = parsed.data;

  if (!(await passesWriteFlagGate(res))) return;

  const body = {
    object_id: campaign_id,
    level: "campaign" as const,
    status: "PAUSED" as const,
    rationale: "Pause requested by the operator from the Ads Manager.",
    over_cap: true,
    about: "Operator-initiated campaign pause.",
    origin: "user_initiated_ledger" as const,
  };

  try {
    const { data, error } = await serviceClient().rpc("emit_decision", {
      p_tenant_id: auth.tenant_id,
      p_agent_run_id: null,
      p_decision_class: "meta_ads.set_status_review",
      p_body: body as object,
    });
    if (error) {
      res.status(500).json({
        error: { code: "emit_failed", message: "Couldn't stage the pause." },
      });
      return;
    }
    res.json({
      ok: true,
      decision_id: data as string,
      campaign_id,
      level: "campaign" as const,
      status: "PAUSED" as const,
    });
  } catch (e) {
    res.status(500).json({
      error: {
        code: "emit_failed",
        message: `Couldn't stage the pause (${(e as Error).message}).`,
      },
    });
  }
}

export async function performanceMarketerCampaignStatus(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const parsed = CampaignStatusBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: "invalid_body",
        message: parsed.error.issues.map((i) => i.message).join("; "),
      },
    });
    return;
  }

  const { channel, campaign_id, campaign_name, enabled } = parsed.data;
  const writeEnabled =
    channel === "meta"
      ? await isMetaAdsWriteEnabled()
      : await isGoogleAdsWriteEnabled();
  if (!writeEnabled) {
    res.status(409).json({
      error: {
        code: `${channel}_ads_write_disabled`,
        message: `${channel === "meta" ? "Meta" : "Google"} Ads changes are disabled at the platform level.`,
      },
    });
    return;
  }
  if (channel === "google" && enabled && (await refuseNonUsdGoogle(res, auth.tenant_id))) return;

  const status = enabled
    ? channel === "meta"
      ? "ACTIVE"
      : "ENABLED"
    : "PAUSED";
  const body =
    channel === "meta"
      ? {
          object_id: campaign_id,
          level: "campaign" as const,
          status,
          rationale: `${enabled ? "Enable" : "Pause"} requested by the operator from Analytics.`,
          over_cap: true,
          ...(campaign_name ? { name: campaign_name } : {}),
          about: "Operator-initiated campaign status change.",
          origin: "user_initiated_ledger" as const,
        }
      : {
          campaign_id,
          status,
          rationale: `${enabled ? "Enable" : "Pause"} requested by the operator from Analytics.`,
          over_cap: true,
          ...(campaign_name ? { name: campaign_name } : {}),
          about: "Operator-initiated campaign status change.",
          origin: "user_initiated_ledger" as const,
        };

  try {
    const { data, error } = await serviceClient().rpc("emit_decision", {
      p_tenant_id: auth.tenant_id,
      p_agent_run_id: null,
      p_decision_class:
        channel === "meta"
          ? "meta_ads.set_status_review"
          : "google_ads.set_status_review",
      p_body: body as object,
    });
    if (error) {
      res.status(500).json({
        error: { code: "emit_failed", message: "Couldn't stage the change." },
      });
      return;
    }
    res.json({ ok: true, decision_id: data as string, campaign_id, status });
  } catch (e) {
    res.status(500).json({
      error: {
        code: "emit_failed",
        message: `Couldn't stage the change (${(e as Error).message}).`,
      },
    });
  }
}

export async function performanceMarketerDecisionStatus(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const decision_id = z.string().uuid().safeParse(req.params.decision_id);
  if (!decision_id.success) {
    res.status(400).json({
      error: { code: "invalid_decision_id", message: "Invalid decision id." },
    });
    return;
  }

  try {
    const { data, error } = await serviceClient()
      .from("decisions")
      .select("status, dispatch_error")
      .eq("id", decision_id.data)
      .eq("tenant_id", auth.tenant_id)
      .maybeSingle();
    if (error) {
      res.status(500).json({
        error: { code: "read_failed", message: "Couldn't read the decision." },
      });
      return;
    }
    if (!data) {
      res.status(404).json({
        error: { code: "not_found", message: "Decision not found." },
      });
      return;
    }
    res.json({
      status: (data as { status: string }).status,
      dispatch_error:
        (data as { dispatch_error: string | null }).dispatch_error ?? null,
    });
  } catch (e) {
    res.status(500).json({
      error: {
        code: "read_failed",
        message: `Couldn't read the decision (${(e as Error).message}).`,
      },
    });
  }
}

const DIFFERENT_CHANGE_OPEN = {
  error: { code: "different_change_open", message: "Another change for this budget is already waiting for approval, so this one was not staged." },
};

export async function stagedDecisionMatches(
  tenant_id: string,
  decision_id: string,
  want: { key: "ad_set_id" | "campaign_id"; id: string; daily_budget_usd: number },
): Promise<boolean> {
  try {
    const { data, error } = await serviceClient()
      .from("decisions")
      .select("status, body")
      .eq("id", decision_id)
      .eq("tenant_id", tenant_id)
      .maybeSingle();
    if (error || !data) return false;
    const r = data as { status?: unknown; body?: Record<string, unknown> | null };
    const b = r.body ?? {};
    return r.status === "proposed" && b[want.key] === want.id && b.daily_budget_usd === want.daily_budget_usd;
  } catch {
    return false;
  }
}
