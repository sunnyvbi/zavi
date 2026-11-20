import { adsUsd } from "./fx";
import { z } from "zod";
import {
  LINKEDIN_LAUNCH_UNCONFIRMED,
  linkedinLaunchUnconfirmedWords,
  linkedinLaunchInput,
  linkedinLaunchSummary,
  launchLinkedinCampaign,
  linkedinUsdDrift,
  linkedinLaunchNotSentError,
} from "./linkedin-launch";
import { requireSharedWalletConsent } from "./consent";
import { loadTenantRoleFor } from "@/services/auth/tenant-role";
import { ExpectedToolError } from "@/services/tools/types";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { classifyExecFailure } from "@/services/channels/exec-failure";

export const LINKEDIN_LAUNCH = "linkedin_ads.launch_campaign";
export const linkedinLaunchProposal = linkedinLaunchInput
  .omit({ request_id: true, snapshot: true })
  .extend({
    campaign_binding_id: z.string().uuid(),
    rationale: z.string().min(10).max(4000),
  })
  .strict();
export const linkedinLaunchBody = linkedinLaunchProposal
  .extend({
    snapshot: linkedinLaunchInput.shape.snapshot,
    name: z.string().min(1),
    currency: z.string().regex(/^[A-Z]{3}$/),
    total_budget_usd: z.number().positive(),
    origin: z.enum(["agent", "user_initiated_chat"]),
    daily_budget_cents: z.number().int().nonnegative().nullable().optional(),
    funding_source: z.string().min(1).optional(),
    spent_so_far_cents: z.number().int().nonnegative().optional(),
    explicit_order: z.literal(true).optional(),
  })
  .strict();
type Decision = {
  id: string;
  tenant_id: string;
  body: unknown;
  approved_by?: string | null;
  approved_by_source?: string | null;
};
export const LINKEDIN_AUTOPILOT_CONSENT_REQUIRED =
  "Autopilot did not launch this LinkedIn campaign because Zavi does not have your shared wallet permission. Autopilot needs it for every LinkedIn launch, even on an ad account LinkedIn bills directly. Authorize it under Shared wallet permission in Ads account settings, or approve this launch yourself.";
export { LINKEDIN_LAUNCH_UNCONFIRMED };
export const LINKEDIN_LAUNCH_REQUEST_USED =
  "Zavi already used this launch request, so it will not send it to LinkedIn again. Check the campaign in LinkedIn Campaign Manager in a few minutes. If it is not running, review the launch again.";
export const LINKEDIN_LAUNCH_RECONCILED_PAUSED =
  "An earlier attempt of this launch did not finish, and Zavi could not confirm whether it reached LinkedIn, so Zavi keeps the campaign paused to be safe. If it did reach LinkedIn it may have run for a short time. Check the campaign in LinkedIn Campaign Manager, then review the launch again.";
export const LINKEDIN_LAUNCH_CHECKING =
  "Zavi could not confirm whether this launch reached LinkedIn and is checking it now. If it still cannot confirm the launch within about 15 minutes, it pauses the campaign to be safe. The budget set aside for it stays held until Zavi confirms what happened.";
export const LINKEDIN_LAUNCH_NOT_REOPENED =
  "Zavi could not reopen this launch request, so approving this card again would do nothing. Review the launch again to send a new one.";
export const LINKEDIN_LAUNCH_ALREADY_DONE =
  "Zavi already launched this LinkedIn campaign with this request, so it did not send it to LinkedIn again.";
export const LINKEDIN_LAUNCH_NOT_REOPENED_CODE = "linkedin_ads_launch_not_reopened";
export const LINKEDIN_LAUNCH_CARD_CHANGED =
  "The campaign or its ads changed after this launch was reviewed, so Zavi closed this card. Nothing was sent to LinkedIn and nothing was held. Review the launch again to send a new one.";
export const LINKEDIN_LAUNCH_NOT_STARTED =
  "Zavi could not start this launch. Nothing was sent to LinkedIn and nothing was held. Try again in a few minutes.";
export const LINKEDIN_LAUNCH_ZAVI_REFUSED_CODE = "linkedin_ads_launch_refused";
const zaviRefused = (error: string) => ({ ok: false as const, code: LINKEDIN_LAUNCH_ZAVI_REFUSED_CODE, error });
const budgetCardRefusal = (raw: unknown): string | null =>
  typeof raw === "string" && classifyExecFailure({ error: raw })?.fix === "ad_budget" ? raw : null;
const closed = (error: string) => ({ ok: false as const, code: LINKEDIN_LAUNCH_NOT_REOPENED_CODE, error });
const noRetry = (error: string) => ({ ok: false as const, code: "exec_outcome_unknown" as const, error });
const notReopened = (error: string) => ({ ok: false as const, code: LINKEDIN_LAUNCH_NOT_REOPENED_CODE, error: `${error} ${LINKEDIN_LAUNCH_NOT_REOPENED}` });
const STATUS_UNREAD = "unread";
async function launchOperationStatus(tenantId: string, requestId: string): Promise<string | null> {
  const r = await tenantClient(asTenantId(tenantId))
    .from("ads_campaign_operations")
    .select("status")
    .eq("id", requestId)
    .maybeSingle();
  if (r.error) return STATUS_UNREAD;
  const status = (r.data as { status?: string } | null)?.status;
  return typeof status === "string" ? status : null;
}
const refuse = (message: string): never => {
  throw new ExpectedToolError("linkedin_launch_permission", message);
};
export const LINKEDIN_AUTOPILOT_UNREAD =
  "Zavi could not check just now whether LinkedIn Autopilot and the monthly ad budget are still on, so Autopilot did not go on with this launch. Try again in a few minutes, or approve it yourself.";
const PERMISSION_READS = 3;
async function autopilotStillOn(tenantId: string): Promise<boolean> {
  const { readChannelAutorun } = await import("@/services/growth/unattended-policy");
  const { readActiveAdBudget } = await import("@/services/decisions/ad-budget");
  for (let attempt = 1; ; attempt++) {
    try {
      return (await readChannelAutorun(tenantId, "linkedin_ads")) && !!(await readActiveAdBudget(tenantId));
    } catch {
      if (attempt >= PERMISSION_READS) throw new ExpectedToolError("linkedin_launch_permission_unread", LINKEDIN_AUTOPILOT_UNREAD);
      await new Promise((r) => setTimeout(r, 200 * attempt));
    }
  }
}
export async function assertLinkedinGrowthPermission(d: Decision) {
  if (d.approved_by_source === "cgo") {
    if (!(await autopilotStillOn(d.tenant_id)))
      refuse("LinkedIn Autopilot or the monthly ad budget was turned off, so Autopilot did not launch this. Nothing was sent to LinkedIn. Approve it yourself to go ahead.");
    try {
      await requireSharedWalletConsent(d.tenant_id);
    } catch (e) {
      if (e instanceof ExpectedToolError && e.code === "ads_consent_required") refuse(LINKEDIN_AUTOPILOT_CONSENT_REQUIRED);
      throw e;
    }
  } else {
    if (!d.approved_by) refuse("An owner or admin must approve this launch.");
    const role = await loadTenantRoleFor(d.approved_by!, d.tenant_id);
    if (role !== "owner" && role !== "admin")
      refuse("Only an owner or admin can approve LinkedIn spending.");
  }
}
export async function executeLinkedinGrowthLaunch(d: Decision) {
  let launching = false;
  let fundingSource: unknown = null;
  try {
    const body = linkedinLaunchBody.parse(d.body);
    await assertLinkedinGrowthPermission(d);
    const summary = await linkedinLaunchSummary(
      d.tenant_id,
      body.campaign_binding_id,
    );
    fundingSource = summary.funding_source;
    if (
      summary.currency !== body.currency ||
      summary.snapshot !== body.snapshot
    )
      return closed(LINKEDIN_LAUNCH_CARD_CHANGED);
    const drift = linkedinUsdDrift(
      adsUsd(body.total_budget_cents / 100, summary.fx),
      body.total_budget_usd,
      summary.currency,
    );
    if (drift && summary.currency === "USD") return closed(LINKEDIN_LAUNCH_CARD_CHANGED);
    if (drift) return closed(drift);
    if (d.approved_by_source === "cgo" && summary.stop_requested_at)
      refuse("A founder must review this campaign's existing pause request.");
    launching = true;
    const result = await launchLinkedinCampaign(
      d.tenant_id,
      body.campaign_binding_id,
      {
        request_id: d.id,
        snapshot: body.snapshot,
        total_budget_cents: body.total_budget_cents,
        end_time: body.end_time,
      },
      () => assertLinkedinGrowthPermission(d),
      { approved_by: d.approved_by, approved_by_source: d.approved_by_source, body: d.body, approved_total_usd: body.total_budget_usd },
    );
    if (result.status !== "active") {
      const status = await launchOperationStatus(d.tenant_id, d.id).catch(() => STATUS_UNREAD);
      if (status === "succeeded") return { ok: true, notice: LINKEDIN_LAUNCH_ALREADY_DONE };
      if (status === "refused") return noRetry(LINKEDIN_LAUNCH_RECONCILED_PAUSED);
      return noRetry(status === "uncertain" ? linkedinLaunchUnconfirmedWords(fundingSource) : status === "pending" ? LINKEDIN_LAUNCH_CHECKING : LINKEDIN_LAUNCH_REQUEST_USED);
    }
    return {
      ok: true,
      notice:
        "notice" in result && result.notice
          ? result.notice
          : "LinkedIn campaign launched within the monthly ad budget using its original account and funding source.",
    };
  } catch (e) {
    const status = launching ? await launchOperationStatus(d.tenant_id, d.id).catch(() => STATUS_UNREAD) : null;
    if (status === "uncertain" || status === "pending") return noRetry(linkedinLaunchUnconfirmedWords(fundingSource));
    if (status === "refused")
      return linkedinLaunchNotSentError(e)
        ? notReopened((e as Error).message)
        : noRetry(LINKEDIN_LAUNCH_RECONCILED_PAUSED);
    if (e instanceof ExpectedToolError && e.meta?.outcome_unknown) return noRetry(e.message);
    if (e instanceof ExpectedToolError && e.meta?.card_cannot_run) return closed(e.message);
    if (e instanceof ExpectedToolError) {
      const budget = budgetCardRefusal(e.meta?.budget_refusal);
      if (budget) return { ok: false, error: budget };
      return e.code.startsWith("linkedin_ads_") || (e.code === "ads_launch_not_sent" && typeof e.meta?.http_status === "number") ? { ok: false, error: e.message } : zaviRefused(e.message);
    }
    if (status === null) return zaviRefused(LINKEDIN_LAUNCH_NOT_STARTED);
    return noRetry("Zavi could not confirm whether this launch reached LinkedIn. Check the campaign in LinkedIn. Any budget set aside for it stays held until Zavi confirms what happened.");
  }
}
