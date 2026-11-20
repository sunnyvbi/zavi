import { ExpectedToolError } from "@/services/tools/types";
import { recordChannelExecAction } from "@/services/channels/exec-actions";
import { openChannelCards } from "@/services/growth/pending-test-claim";
import { LINKEDIN_CHANGE_CARDS } from "@/services/tools/linkedin-ads/_exec-action";
import {
  LINKEDIN_AD_STATUS_CLASS,
  LINKEDIN_ARCHIVE_CLASS,
  LINKEDIN_DUPLICATE_CLASS,
  LINKEDIN_GROUP_EDIT_CLASS,
  linkedinAdStatusBodySchema,
  linkedinArchiveBodySchema,
  linkedinDuplicateBodySchema,
  linkedinGroupEditBodySchema,
  type LinkedInAdStatusBody,
  type LinkedInArchiveBody,
  type LinkedInDuplicateBody,
  type LinkedInGroupEditBody,
} from "@/services/tools/linkedin-ads/_change-bodies";
import { withLinkedInAdsToken } from "./client";
import { listLinkedInRawCampaignsInGroupWithToken, listLinkedInRawCreativesWithToken, readLinkedInRawCampaign, readLinkedInRawCampaignGroup, type LiRawCampaign, type LiRawCampaignGroup } from "./write";
import { insertFounderRun } from "./propose-pause";

const CHANNEL = "linkedin_ads";
export const FOUNDER_ARCHIVE_RUN_STAGE = "linkedin_ads_founder_archive";
export const FOUNDER_GROUP_STATUS_RUN_STAGE = "linkedin_ads_founder_group_status";
export const FOUNDER_AD_STATUS_RUN_STAGE = "linkedin_ads_founder_ad_status";
export const FOUNDER_DUPLICATE_RUN_STAGE = "linkedin_ads_founder_duplicate";

type Status = "ACTIVE" | "PAUSED";
type Mode = "archive" | "delete";
type Filed = { action_id: string };

const rationale = (did: string) => `You asked Zavi to ${did} from the LinkedIn Ads channel page.`;
const msToIso = (ms: unknown): string | null => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const lower = (s: string | null | undefined) => (s ? s.toLowerCase() : "in an unknown state");

const pending = (card: "archive" | "group_status" | "ad_status" | "duplicate", what: string) =>
  new ExpectedToolError(`linkedin_ads_${card}_pending`, `${what} is already waiting in Next steps. Approve or dismiss that one.`);

async function refuseWalletCampaign(tenant_id: string, campaign_id: string, what: string): Promise<void> {
  const { findCampaignBinding } = await import("@/services/ads-wallet/bindings");
  const bound = await findCampaignBinding(tenant_id, "linkedin", campaign_id);
  if (bound?.funding_source === "wallet")
    throw new ExpectedToolError("linkedin_ads_wallet_campaign", `This campaign runs in Zavi's shared LinkedIn ad account and is paid from your Zavi wallet, so ${what}.`);
}

async function requireAccountInUse(tenant_id: string, account_id: string): Promise<void> {
  const { linkedinAccountInUse } = await import("./own-accounts");
  if (!(await linkedinAccountInUse(tenant_id, account_id)))
    throw new ExpectedToolError("linkedin_ads_account_not_in_use", "This ad account is not one this workspace uses. Refresh the page, then try again.");
}

async function liveCampaign(tenant_id: string, account_id: string, campaign_id: string): Promise<LiRawCampaign & { id: string; name: string }> {
  const live = await readLinkedInRawCampaign(tenant_id, account_id, campaign_id);
  if (!live) throw new ExpectedToolError("linkedin_ads_campaign_not_found", "This campaign is not in this LinkedIn Ads account. Refresh the campaign list, then try again.");
  const id = String(live.id);
  return { ...live, id, name: live.name ?? id };
}

async function liveGroup(tenant_id: string, account_id: string, group_id: string): Promise<LiRawCampaignGroup & { id: string; name: string }> {
  const live = await readLinkedInRawCampaignGroup(tenant_id, account_id, group_id);
  if (!live) throw new ExpectedToolError("linkedin_ads_group_not_found", "This campaign group is not in this LinkedIn Ads account. Refresh the page, then try again.");
  const id = String(live.id);
  return { ...live, id, name: live.name ?? id };
}

async function file(tenant_id: string, now: Date, stage: string, text: string, execClass: string, body: Record<string, unknown>, alreadyWaiting: () => ExpectedToolError): Promise<string> {
  const spec = LINKEDIN_CHANGE_CARDS[execClass];
  const { title, card } = spec.build(body);
  const run_id = await insertFounderRun(tenant_id, now, stage, text);
  const filed = await recordChannelExecAction(
    { tenantId: tenant_id, runId: run_id, channelSlug: CHANNEL, execClass, execPayload: body, actionType: spec.actionType, title, body: card },
    undefined,
    { enabled: () => false },
  );
  if (filed.kept) throw alreadyWaiting();
  return filed.id;
}

const ARCHIVABLE = new Set(["PAUSED", "COMPLETED", "DRAFT"]);

export async function proposeLinkedInArchiveForFounder(
  tenant_id: string,
  input: { campaign_id: string; account_id: string; mode?: Mode },
  now: Date = new Date(),
): Promise<Filed & { campaign: { id: string; name: string; was: string; mode: Mode } }> {
  const mode: Mode = input.mode ?? "archive";
  const waiting = () => pending("archive", `An ${mode === "delete" ? "archive or delete" : "archive"} for this campaign`);
  const open = await openChannelCards(tenant_id, CHANNEL, LINKEDIN_ARCHIVE_CLASS);
  if (open.some((c) => c.exec_payload?.target === "campaign" && c.exec_payload?.id === input.campaign_id)) throw waiting();
  await refuseWalletCampaign(tenant_id, input.campaign_id, "only its launch flow in Zavi can retire it");
  await requireAccountInUse(tenant_id, input.account_id);
  const live = await liveCampaign(tenant_id, input.account_id, input.campaign_id);
  if (live.status === "ACTIVE") throw new ExpectedToolError("linkedin_ads_campaign_active", `"${live.name}" is running. Pause it first; Zavi never ${mode === "delete" ? "deletes" : "archives"} a running campaign.`);
  if (!live.status || !ARCHIVABLE.has(live.status))
    throw new ExpectedToolError("linkedin_ads_campaign_not_archivable", `"${live.name}" is ${lower(live.status)}, so there is nothing to ${mode}.`);
  const body: LinkedInArchiveBody = linkedinArchiveBodySchema.parse({
    target: "campaign",
    id: live.id,
    account_id: input.account_id,
    campaign_id: null,
    name: live.name,
    expected_status: live.status,
    mode,
    rationale: rationale(`${mode} this campaign`),
  });
  const action_id = await file(tenant_id, now, FOUNDER_ARCHIVE_RUN_STAGE, `The founder asked Zavi to ${mode} a LinkedIn campaign (no model run).`, LINKEDIN_ARCHIVE_CLASS, body, waiting);
  return { action_id, campaign: { id: live.id, name: live.name, was: live.status, mode } };
}

export async function proposeLinkedInGroupStatusForFounder(
  tenant_id: string,
  input: { group_id: string; account_id: string; status: Status },
  now: Date = new Date(),
): Promise<Filed & { group: { id: string; name: string; was: Status; status: Status } }> {
  const word = input.status === "PAUSED" ? "pause" : "restart";
  const waiting = () => pending("group_status", `A ${word} for this campaign group`);
  const open = await openChannelCards(tenant_id, CHANNEL, LINKEDIN_GROUP_EDIT_CLASS);
  if (open.some((c) => c.exec_payload?.group_id === input.group_id)) throw waiting();
  await requireAccountInUse(tenant_id, input.account_id);
  const live = await liveGroup(tenant_id, input.account_id, input.group_id);
  if (live.backfilled) throw new ExpectedToolError("linkedin_ads_default_group", `"${live.name}" is the account's default campaign group, which LinkedIn does not let anyone pause or edit.`);
  if (live.status !== "ACTIVE" && live.status !== "PAUSED")
    throw new ExpectedToolError("linkedin_ads_group_ended", `"${live.name}" is ${lower(live.status)}, so it cannot be ${input.status === "PAUSED" ? "paused" : "restarted"}.`);
  if (live.status === input.status) throw new ExpectedToolError("linkedin_ads_group_status_same", `"${live.name}" is already ${input.status === "PAUSED" ? "paused" : "running"}.`);
  const body: LinkedInGroupEditBody = linkedinGroupEditBodySchema.parse({
    group_id: live.id,
    account_id: input.account_id,
    name: live.name,
    rationale: rationale(`${word} this campaign group`),
    last_modified_at: msToIso(live.changeAuditStamps?.lastModified?.time),
    changes: { status: { before: live.status, after: input.status } },
  });
  const action_id = await file(tenant_id, now, FOUNDER_GROUP_STATUS_RUN_STAGE, `The founder asked Zavi to ${word} a LinkedIn campaign group (no model run).`, LINKEDIN_GROUP_EDIT_CLASS, body, waiting);
  return { action_id, group: { id: live.id, name: live.name, was: live.status, status: input.status } };
}

const SWITCHABLE = new Set(["ACTIVE", "PAUSED", "DRAFT"]);

export async function proposeLinkedInAdStatusForFounder(
  tenant_id: string,
  input: { creative_id: string; campaign_id: string; account_id: string; status: Status },
  now: Date = new Date(),
): Promise<Filed & { ad: { id: string; name: string; campaign_id: string; was: string; status: Status } }> {
  const word = input.status === "PAUSED" ? "turn off" : "turn on";
  const waiting = () => pending("ad_status", "A change to this ad");
  const open = await openChannelCards(tenant_id, CHANNEL, LINKEDIN_AD_STATUS_CLASS);
  if (open.some((c) => c.exec_payload?.creative_id === input.creative_id)) throw waiting();
  await refuseWalletCampaign(tenant_id, input.campaign_id, "its ads are managed through its launch flow in Zavi");
  await requireAccountInUse(tenant_id, input.account_id);
  const campaign = await liveCampaign(tenant_id, input.account_id, input.campaign_id);
  const ads = await withLinkedInAdsToken(tenant_id, (token) => listLinkedInRawCreativesWithToken(token, input.account_id, campaign.id));
  const ad = ads.find((a) => a.creative_id === input.creative_id);
  if (!ad) throw new ExpectedToolError("linkedin_ads_ad_not_found", `This ad is not in the campaign "${campaign.name}". Refresh the page, then try again.`);
  const ad_name = ad.name?.trim() || `Ad ${ad.creative_id}`;
  const was = ad.intendedStatus ?? null;
  if (!was || !SWITCHABLE.has(was)) throw new ExpectedToolError("linkedin_ads_ad_not_switchable", `The ad "${ad_name}" is ${lower(was)}, so it cannot be turned ${input.status === "PAUSED" ? "off" : "on"}.`);
  if (was === input.status) throw new ExpectedToolError("linkedin_ads_ad_status_same", `The ad "${ad_name}" is already ${input.status === "PAUSED" ? "off" : "on"}.`);
  if (input.status === "PAUSED" && campaign.status === "ACTIVE" && ads.filter((a) => a.intendedStatus === "ACTIVE").length <= 1)
    throw new ExpectedToolError("linkedin_ads_last_live_ad", `The ad "${ad_name}" is the only ad that is on in the running campaign "${campaign.name}". Turning it off would leave the campaign with nothing to show. Add another ad first, or pause the campaign.`);
  const body: LinkedInAdStatusBody = linkedinAdStatusBodySchema.parse({
    creative_id: ad.creative_id,
    campaign_id: campaign.id,
    account_id: input.account_id,
    campaign_name: campaign.name,
    ad_name,
    expected_status: was,
    status: input.status,
    rationale: rationale(`${word} this ad`),
  });
  const action_id = await file(tenant_id, now, FOUNDER_AD_STATUS_RUN_STAGE, `The founder asked Zavi to ${word} a LinkedIn ad (no model run).`, LINKEDIN_AD_STATUS_CLASS, body, waiting);
  return { action_id, ad: { id: ad.creative_id, name: ad_name, campaign_id: campaign.id, was, status: input.status } };
}

const copyName = (name: string, wanted: string | undefined) => (wanted?.trim() || `${name} (copy)`).slice(0, 255);

export async function proposeLinkedInDuplicateForFounder(
  tenant_id: string,
  input: { target: "campaign" | "campaign_group"; source_id: string; account_id: string; new_name?: string },
  now: Date = new Date(),
): Promise<Filed & { copy: { target: "campaign" | "campaign_group"; source_id: string; source_name: string; new_name: string } }> {
  const what = input.target === "campaign" ? "campaign" : "campaign group";
  const waiting = () => pending("duplicate", `A copy of this ${what}`);
  const open = await openChannelCards(tenant_id, CHANNEL, LINKEDIN_DUPLICATE_CLASS);
  if (open.some((c) => c.exec_payload?.target === input.target && c.exec_payload?.source_id === input.source_id)) throw waiting();
  if (input.target === "campaign") await refuseWalletCampaign(tenant_id, input.source_id, "it cannot be copied from here");
  await requireAccountInUse(tenant_id, input.account_id);
  const live = input.target === "campaign" ? await liveCampaign(tenant_id, input.account_id, input.source_id) : await liveGroup(tenant_id, input.account_id, input.source_id);
  if (input.target === "campaign_group") {
    const campaigns = await withLinkedInAdsToken(tenant_id, (token) => listLinkedInRawCampaignsInGroupWithToken(token, input.account_id, live.id));
    for (const c of campaigns) {
      if (c.status === "ARCHIVED" || c.status === "PENDING_DELETION" || c.status === "CANCELED") continue;
      await refuseWalletCampaign(tenant_id, String(c.id), `the group that holds it cannot be copied from here`);
    }
  }
  const new_name = copyName(live.name, input.new_name);
  const body: LinkedInDuplicateBody = linkedinDuplicateBodySchema.parse({
    target: input.target,
    source_id: live.id,
    account_id: input.account_id,
    source_name: live.name,
    new_name,
    group_id: null,
    campaign_id: null,
    copy_ads: true,
    source_last_modified_at: msToIso(live.changeAuditStamps?.lastModified?.time),
    rationale: rationale(`copy this ${what}`),
  });
  const action_id = await file(tenant_id, now, FOUNDER_DUPLICATE_RUN_STAGE, `The founder asked Zavi to copy a LinkedIn ${what} (no model run).`, LINKEDIN_DUPLICATE_CLASS, body, waiting);
  return { action_id, copy: { target: input.target, source_id: live.id, source_name: live.name, new_name } };
}
