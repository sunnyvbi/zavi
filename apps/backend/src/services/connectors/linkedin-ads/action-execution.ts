
import { z } from "zod";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { LINKEDIN_PLAN_UNREAD, linkedinPlanState } from "./plan-check";
import { comingSoonMessage, isChannelLockedStrict } from "@/services/channels/lock";
import { ExpectedToolError } from "@/services/tools/types";
import { isLinkedInAdsWriteEnabled } from "@/services/tools/linkedin-ads/write/_flag-check";
import { creationJournal, inFlightResolvable } from "./creation-progress";
import { LINKEDIN_ADS_DAILY_LIMIT, logLinkedInRefusal } from "./http";
import { getAccountBinding } from "@/services/ads-wallet/bindings";
import { logEvent } from "@/services/logging/logEvent";
import { isPartialRiskExecCode } from "@zavi/shared";
import {
  ACCOUNT_CHANGED,
  CHANGED_IN_LINKEDIN,
  createLinkedInCampaignBundle,
  LINKEDIN_ACCOUNT_DISABLED,
  NOT_STARTED,
  NOTHING_SENT,
  POST_AUTHOR_REFUSED,
  POST_MISSING,
  PROGRESS_UNSAVED,
  ZAVI_SAVE_FAILED,
  linkedinBundleCampaign,
  linkedinBundleCreative,
  linkedinBundleGroup,
} from "./write";

export const ACCOUNT_TURNED_OFF = "linkedin_ads_account_turned_off";
export const ZAVI_INCOMPLETE = "linkedin_ads_zavi_incomplete";
export const CREATION_UNCONFIRMED = "linkedin_ads_creation_unconfirmed";
export const DAILY_LIMIT = "linkedin_ads_daily_limit";
export const RATE_LIMITED = "linkedin_ads_rate_limited";
export const WALLET_CONSENT_WITHDRAWN = "linkedin_ads_wallet_consent_withdrawn";

export function linkedinGroupName(name: string, actionId: string): string {
  const tag = ` (Zavi ${actionId.slice(0, 8)})`;
  return `${name.slice(0, 200 - tag.length).trimEnd()}${tag}`;
}

const FOUNDER_FIX_CODES = new Set(["linkedin_ads_token_revoked", "linkedin_ads_not_connected", "linkedin_ads_forbidden"]);

function unconfirmedCopy(step: "campaign_id" | "creative_id", e: unknown, groupName: string): string {
  const what = step === "campaign_id" ? "the paused campaign" : "the draft ad";
  const where = step === "campaign_id" ? `the campaign group it made, ${groupName}` : `the paused campaign it made in ${groupName}`;
  const safety = "Nothing can spend: everything Zavi made is paused.";
  if (e instanceof ExpectedToolError && e.meta?.[PROGRESS_UNSAVED] === step)
    return `LinkedIn made ${what}, but Zavi could not save that it did. ${safety} Choose Try again: Zavi finds ${what} in ${where}, reuses it and finishes the remaining steps without creating anything twice.`;
  const fix = e instanceof ExpectedToolError && FOUNDER_FIX_CODES.has(e.code) ? `${e.message} ` : "";
  return `${fix}LinkedIn did not answer clearly while Zavi was creating ${what}, so Zavi cannot tell yet whether it was made. ${safety} Choose Try again in a few minutes: Zavi first looks in ${where} for ${what}, reuses it if it is there and creates it only if it is not, so nothing is made twice.`;
}
const ZAVI_SIDE_CODES = new Set([NOT_STARTED, "ads_accounts_unavailable", "ads_credentials_unavailable", "ads_binding_unavailable"]);
const zaviSide = (e: unknown) => !(e instanceof ExpectedToolError) || ZAVI_SIDE_CODES.has(e.code) || e.meta?.[ZAVI_SAVE_FAILED] === true;

const fail = (message: string): never => {
  throw new ExpectedToolError("linkedin_ads_conflict", message);
};

const BID_REFUSAL = /\bunitCost\b|\bbid(?:s|ding)?\b/i;
const AUDIENCE_REFUSAL = /\btargetingCriteria\b|\baudience\b/i;

function fixedSettingRefusal(e: unknown, bundle: z.infer<typeof linkedinBundleSchema>, wallet = false): string | null {
  if (!(e instanceof ExpectedToolError) || e.code !== "linkedin_ads_write_refused" || ![400, 422].includes(e.meta?.status as number)) return null;
  const reason = typeof e.meta?.linkedin_reason === "string" ? e.meta.linkedin_reason : "";
  const leftBehind = `The empty campaign group Zavi made, ${bundle.group.name}, stays paused, so nothing can spend. ${wallet ? WALLET_REMOVES : "You can remove it in LinkedIn Campaign Manager."}`;
  if (BID_REFUSAL.test(reason)) {
    const bid = bundle.campaign.unit_cost;
    return `LinkedIn refused this campaign's bid of ${bid.amount} ${bid.currency}, and a bid cannot be changed once a campaign is approved. Start a new campaign in Zavi and enter a higher bid. ${leftBehind}`;
  }
  if (AUDIENCE_REFUSAL.test(reason)) {
    return `LinkedIn refused this campaign's audience, and an audience cannot be changed once a campaign is approved. Start a new campaign in Zavi with more locations or a wider professional audience. ${leftBehind}`;
  }
  return null;
}

const WALLET_REMOVES = "It sits in Zavi's shared LinkedIn ad account, which you do not manage, so there is nothing for you to fix or remove in LinkedIn: Zavi removes it.";
const WALLET_OWN_FIX = /Campaign Manager|reconnect|Correct the issue in LinkedIn/i;

type CreateFailure = { ok: false; code: string; error: string; [key: string]: unknown };

async function walletFailure<T extends { ok: boolean }>(r: T, tenantId: string, actionId: string, groupName: string, state: { group_id: string | null; campaign_id: string | null; creative_id: string | null }): Promise<T> {
  if (r.ok) return r;
  const f = r as unknown as CreateFailure;
  if (isPartialRiskExecCode(f.code)) {
    await logEvent({ level: "error", source: "linkedin-ads", code: "linkedin_ads.wallet_leftover", tenant_id: tenantId, message: "A campaign in Zavi's shared LinkedIn ad account stopped partway and needs Zavi to remove what it made.", meta: { action_id: actionId, group_id: state.group_id, campaign_id: state.campaign_id, creative_id: state.creative_id, failure_class: f.code } }).catch(() => undefined);
    if (!WALLET_OWN_FIX.test(f.error)) return { ...r, managed: true } as T;
    return { ...r, managed: true, error: `Zavi could not finish this campaign, so it stopped and will not try this one again. What it made, named ${groupName}, stays paused, so nothing can spend. ${WALLET_REMOVES} Start a new campaign in Zavi when you are ready.` } as T;
  }
  if (!WALLET_OWN_FIX.test(f.error)) return { ...r, managed: true } as T;
  const made = !!state.group_id;
  return {
    ...r,
    managed: true,
    error: made
      ? "Zavi could not finish this campaign in its shared LinkedIn ad account. There is nothing for you to do in LinkedIn: that account is Zavi's. What Zavi made stays paused, so nothing can spend. Choose Try again: Zavi reuses what it made and finishes the remaining steps without creating anything twice."
      : "Zavi could not create this campaign in its shared LinkedIn ad account, and nothing was created in LinkedIn. There is nothing for you to do in LinkedIn: that account is Zavi's. Choose Try again.",
  } as T;
}

export const linkedinBundleSchema = z
  .object({
    account_id: z.string().regex(/^\d{1,20}$/),
    account_binding_id: z.string().uuid().optional(),
    group: linkedinBundleGroup,
    campaign: linkedinBundleCampaign,
    creative: linkedinBundleCreative,
  })
  .strict();

type StoredAction = {
  status: string;
  exec_class: string | null;
  exec_status: string | null;
  exec_payload: unknown;
  approved_by: string | null;
  exec_claim_id: string | null;
  exec_progress: unknown;
};

export async function executeLinkedInCampaignAction(actionId: string, tenantId: string, actorId: string | null, claimId?: string) {
  z.string().uuid().parse(actionId);
  const sb = tenantClient(asTenantId(tenantId));
  const { data: row, error } = await sb
    .from("channel_actions")
    .select("id, channel_slug, status, exec_class, exec_status, exec_payload, approved_by, exec_claim_id, exec_progress")
    .eq("id", actionId)
    .eq("channel_slug", "linkedin_ads")
    .maybeSingle();
  if (error) throw new Error("Could not read campaign action.");
  if (!row) throw new ExpectedToolError("linkedin_ads_not_found", "Action not found in this workspace.");
  const action = row as StoredAction;

  if (
    !actorId ||
    !claimId || action.exec_claim_id !== claimId ||
    action.approved_by !== actorId ||
    action.exec_class !== "linkedin_ads.create_campaign_bundle" ||
    action.exec_status !== "dispatching"
  ) {
    return fail("This campaign needs administrator approval.");
  }
  const { data: member, error: memberError } = await sb.from("tenant_users").select("role").eq("user_id", actorId).maybeSingle();
  if (memberError || !member || !["owner", "admin"].includes((member as { role: string }).role)) {
    return fail("An owner or administrator must approve this campaign.");
  }
  if (!(await isLinkedInAdsWriteEnabled())) {
    return fail("LinkedIn Ads changes are switched off on this server. Nothing was created.");
  }
  const plan = await linkedinPlanState(tenantId);
  if (plan === "unread") {
    return { ok: false as const, code: "exec_failed" as const, error: `${LINKEDIN_PLAN_UNREAD} Approve the campaign again to retry.` };
  }
  if (plan === "not_on_plan") {
    return fail("LinkedIn Ads is not available for this workspace.");
  }
  const locked = await isChannelLockedStrict("linkedin_ads").catch(() => null);
  if (locked === null) {
    return {
      ok: false as const,
      code: "exec_failed" as const,
      error: "Zavi could not check whether LinkedIn Ads is available, so nothing was created in LinkedIn. Approve the campaign again in a minute to retry.",
    };
  }
  if (locked) {
    return fail(comingSoonMessage("LinkedIn Ads"));
  }
  const approved = linkedinBundleSchema.parse(action.exec_payload);
  const groupName = linkedinGroupName(approved.group.name, actionId);
  const value = { ...approved, group: { name: groupName } };
  const journal = creationJournal(tenantId, actionId, claimId, action.exec_payload, action.exec_progress);

  let wallet = false;
  const failure = async (e: unknown) => {
    await logLinkedInRefusal(e, { tenantId, objectId: actionId, stage: "create_bundle" });
    if (e instanceof ExpectedToolError && e.code === POST_AUTHOR_REFUSED) {
      const archived = e.meta?.archived as { group?: unknown } | undefined;
      return {
        ok: false as const,
        code: POST_AUTHOR_REFUSED,
        error: e.message,
        ...(e.meta?.[POST_MISSING] ? { [POST_MISSING]: true } : {}),
        ...(archived || journal.state.archived ? { archived: { group: archived ? archived.group === true : null, group_name: groupName } } : {}),
      };
    }
    if (e instanceof ExpectedToolError && e.code === ACCOUNT_CHANGED) {
      if (!journal.state.group_id) return { ok: false as const, code: ACCOUNT_CHANGED, error: `${e.message} Nothing was created in LinkedIn.` };
      const made = journal.state.creative_id ? "the campaign group, the paused campaign and its draft ad" : journal.state.campaign_id ? "the campaign group and the paused campaign" : "the campaign group";
      return {
        ok: false as const,
        code: "exec_partial" as const,
        error: `${e.message} Zavi stopped and will not try this campaign again. What it already made in LinkedIn, ${made} named ${value.group.name}, ${journal.state.creative_id ? "stays off" : "stays paused"}, so nothing can spend. Remove it in LinkedIn Campaign Manager.`,
      };
    }
    const kept = journal.state.group_id ? "What Zavi already made stays paused, so nothing can spend, and Zavi reuses it." : "Nothing was created in LinkedIn.";
    if (e instanceof ExpectedToolError && !journal.state.in_flight && e.code === "ads_consent_required") {
      return { ok: false as const, code: WALLET_CONSENT_WITHDRAWN, error: `Zavi's permission to spend from the shared wallet was withdrawn, so Zavi stopped. ${kept} Choose Authorize shared wallet in this channel's ad account settings, then choose Try again.` };
    }
    if (e instanceof ExpectedToolError && !journal.state.in_flight && e.meta?.status === 429) {
      return e.message === LINKEDIN_ADS_DAILY_LIMIT
        ? { ok: false as const, code: DAILY_LIMIT, error: `LinkedIn's daily allowance of requests for this connection is used up, so Zavi paused here. ${kept} It resets at 00:00 UTC. Choose Try again after that.` }
        : { ok: false as const, code: RATE_LIMITED, error: `LinkedIn is busy right now and asked Zavi to slow down, so Zavi paused here. ${kept} Choose Try again in a few minutes.` };
    }
    if (e instanceof ExpectedToolError && e.meta?.[NOTHING_SENT] && !journal.state.group_id && !journal.state.in_flight) {
      if (e.code === "ads_account_mismatch") {
        return { ok: false as const, code: ACCOUNT_CHANGED, error: `${e.message} Nothing was created in LinkedIn. Start a new campaign and review it again.` };
      }
      if (e.code === "linkedin_ads_post_page_mismatch") return { ok: false as const, code: POST_AUTHOR_REFUSED, error: e.message };
    }
    const nothingMade = e instanceof ExpectedToolError && e.meta?.[NOTHING_SENT] && !journal.state.group_id && !journal.state.in_flight;
    if (e instanceof ExpectedToolError && e.code === LINKEDIN_ACCOUNT_DISABLED && (nothingMade || journal.retryable || inFlightResolvable(journal.state))) {
      return {
        ok: false as const,
        code: ACCOUNT_TURNED_OFF,
        error: nothingMade
          ? e.message
          : "You turned this ad account off in Zavi with Stop using this account, so Zavi did not finish the campaign. Campaign setup is saved and stays paused. Turn the account back on with Use this account again, then choose Try again.",
      };
    }
    if (nothingMade && zaviSide(e)) {
      return {
        ok: false as const,
        code: ZAVI_INCOMPLETE,
        error: "Zavi could not finish its own checks before creating the campaign. This was a problem on Zavi's side, not in LinkedIn, and nothing was created in LinkedIn. Choose Try again.",
      };
    }
    if (nothingMade && e instanceof ExpectedToolError) {
      return {
        ok: false as const,
        code: "exec_failed" as const,
        error: /nothing was created/i.test(e.message) ? e.message : `${e.message} Nothing was created in LinkedIn. Fix this, then approve the campaign again.`,
      };
    }
    if (journal.retryable && zaviSide(e)) {
      return {
        ok: false as const,
        code: ZAVI_INCOMPLETE,
        error: `${e instanceof ExpectedToolError ? `${e.message} ` : ""}This was a problem on Zavi's side, not in LinkedIn, so there is nothing to fix in LinkedIn. What Zavi already made stays paused, so nothing can spend. Choose Try again: Zavi will reuse what it made and finish the remaining steps without creating anything twice.`,
      };
    }
    if (journal.state.group_id && e instanceof ExpectedToolError && ["ads_account_mismatch", "linkedin_ads_post_page_mismatch"].includes(e.code)) {
      return {
        ok: false as const,
        code: "exec_partial" as const,
        error: `${e.message} Zavi stopped and will not try this campaign again, because LinkedIn cannot fix this. What it made stays paused in LinkedIn, so nothing can spend. Open LinkedIn Campaign Manager to remove it, then approve a new campaign in Zavi.`,
      };
    }
    if (e instanceof ExpectedToolError && e.code === "exec_partial" && e.meta?.[CHANGED_IN_LINKEDIN]) {
      return {
        ok: false as const,
        code: "exec_partial" as const,
        error: `${e.message} Edits to its name, budget, bid or audience are fine, but this one means Zavi cannot be sure the next step lands on the campaign it made, so Zavi stopped and will not finish this campaign. Open LinkedIn Campaign Manager to pause or remove what Zavi made, then approve a new campaign in Zavi. Do not activate it there: launch only from Zavi, which holds the budget first.`,
      };
    }
    const step = journal.state.in_flight;
    if ((step === "campaign_id" || step === "creative_id") && inFlightResolvable(journal.state) && !(e instanceof ExpectedToolError && e.code === "exec_partial" && e.meta?.[PROGRESS_UNSAVED] !== step)) {
      return { ok: false as const, code: CREATION_UNCONFIRMED, error: unconfirmedCopy(step, e, groupName) };
    }
    const unsavedGroup = e instanceof ExpectedToolError && e.meta?.[PROGRESS_UNSAVED] === "group_id" ? (e.meta.made as { group_id?: string | null } | undefined)?.group_id : null;
    if (unsavedGroup) {
      return {
        ok: false as const,
        code: "exec_partial" as const,
        error: `Zavi made the campaign group ${groupName} (ID ${unsavedGroup}) in LinkedIn, but could not save that it did, so Zavi stopped and will not try this campaign again. The group is empty, so nothing can spend. Remove it in LinkedIn Campaign Manager, then approve a new campaign in Zavi.`,
      };
    }
    const fixedSetting = journal.state.group_id && !journal.state.campaign_id ? fixedSettingRefusal(e, value, wallet) : null;
    if (fixedSetting) return { ok: false as const, code: "exec_partial" as const, error: fixedSetting };
    if (journal.retryable && !(e instanceof ExpectedToolError && e.code === "exec_partial")) {
      return {
        ok: false as const,
        code: "linkedin_ads_creation_incomplete",
        error: !journal.state.group_id
          ? `${e instanceof ExpectedToolError ? `${e.message} ` : ""}LinkedIn refused the first step, creating the campaign group, so nothing was created in LinkedIn. Correct the issue in LinkedIn, then choose Try again.`
          : `${e instanceof ExpectedToolError ? `${e.message} ` : ""}Campaign setup is saved. Correct the issue in LinkedIn, then choose Try again to finish the remaining steps. Zavi will reuse the saved setup and keep the campaign paused.`,
      };
    }
    const made = (e instanceof ExpectedToolError && e.meta?.made ? e.meta.made : journal.state.group_id ? journal.state : null) as
      | { group_id: string | null; campaign_id: string | null }
      | null;
    if (!made?.group_id && e instanceof ExpectedToolError && e.code === "linkedin_ads_post_page_mismatch") {
      return { ok: false as const, code: POST_AUTHOR_REFUSED, error: e.message };
    }
    const cleanRefusal =
      e instanceof ExpectedToolError &&
      ["linkedin_ads_write_refused", "linkedin_ads_forbidden", "linkedin_ads_token_revoked", "linkedin_ads_bad_path", "linkedin_ads_not_connected"].includes(e.code);
    const detail = e instanceof ExpectedToolError ? ` (${e.message})` : "";
    if (!made?.group_id) {
      return cleanRefusal
        ? {
            ok: false as const,
            code: "exec_failed" as const,
            error: `LinkedIn refused the first step, creating the campaign group${detail}, so nothing was created in LinkedIn. Fix this, then approve the campaign again.`,
          }
        : {
            ok: false as const,
            code: "exec_outcome_unknown" as const,
            error: `The first step, creating the campaign group, did not come back clearly, so Zavi cannot tell whether LinkedIn created it. Zavi did not try again, so nothing is created twice. Check LinkedIn Campaign Manager for a campaign group named ${value.group.name}: if it is there, remove it. Do not activate it there: launch only from Zavi, which holds the budget first.`,
          };
    }
    const created = `the campaign group ${groupName} (ID ${made.group_id})${made.campaign_id ? ` and the paused campaign in it (ID ${made.campaign_id})` : ""}`;
    return {
      ok: false as const,
      code: "exec_partial" as const,
      error: `Created ${created}, then the rest ${cleanRefusal ? "was refused" : "did not come back clearly"}${cleanRefusal ? detail : ""}. Zavi did not try again, so nothing is created twice. Open LinkedIn Campaign Manager to remove it there. Do not activate it there: launch only from Zavi, which holds the budget first.`,
    };
  };
  try {
    await createLinkedInCampaignBundle(tenantId, value.account_id, value, value.account_binding_id, journal);
    return {
      ok: true as const,
      notice: `Created the campaign group, the paused campaign and its draft ad. Nothing can spend until you launch it. Review the campaign in Zavi before launching. Find it in LinkedIn Campaign Manager as ${value.campaign.name}.`,
    };
  } catch (e) {
    wallet = value.account_binding_id ? await getAccountBinding(tenantId, value.account_binding_id).then((b) => b.funding_source === "wallet", () => false) : false;
    const failed = await failure(e);
    return wallet ? walletFailure(failed, tenantId, actionId, groupName, journal.state) : failed;
  }
}
