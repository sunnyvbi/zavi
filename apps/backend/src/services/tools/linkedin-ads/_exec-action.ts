import {
  LINKEDIN_LAUNCH,
  linkedinLaunchBody,
} from "@/services/ads-wallet/linkedin-growth";

import {
  recordChannelExecAction,
  type ExecActionResult,
  type ExecMatchDeps,
} from "@/services/channels/exec-actions";
import {
  isUnstampedCgoRun,
  readsAsCgoRun,
  resolveChannelExecEmit,
  type EmitDecisionFn,
  type ExecEmitCtx,
} from "@/services/channels/exec-emit";
import { ExpectedToolError } from "@/services/tools/types";
import type { z } from "zod";
import {
  LINKEDIN_AD_STATUS_CLASS,
  LINKEDIN_ARCHIVE_CLASS,
  LINKEDIN_BUDGET_CLASS,
  LINKEDIN_CAMPAIGN_EDIT_CLASS,
  LINKEDIN_CREATE_AD_CLASS,
  LINKEDIN_CREATE_CAMPAIGN_CLASS,
  LINKEDIN_DUPLICATE_CLASS,
  LINKEDIN_GROUP_EDIT_CLASS,
  LINKEDIN_RESUME_CLASS,
  LINKEDIN_SWAP_AD_CLASS,
  LINKEDIN_TARGETING_CLASS,
  buildLinkedInAdStatusCardBody,
  buildLinkedInArchiveCardBody,
  buildLinkedInBudgetCardBody,
  buildLinkedInCampaignEditCardBody,
  buildLinkedInCreateAdCardBody,
  buildLinkedInCreateCampaignCardBody,
  buildLinkedInDuplicateCardBody,
  buildLinkedInGroupEditCardBody,
  buildLinkedInResumeCardBody,
  buildLinkedInSwapAdCardBody,
  buildLinkedInTargetingCardBody,
  linkedinAdStatusBodySchema,
  linkedinArchiveBodySchema,
  linkedinBudgetBodySchema,
  linkedinCampaignEditBodySchema,
  linkedinCreateAdBodySchema,
  linkedinCreateCampaignBodySchema,
  linkedinDuplicateBodySchema,
  linkedinGroupEditBodySchema,
  linkedinResumeBodySchema,
  linkedinSwapAdBodySchema,
  linkedinTargetingBodySchema,
} from "./_change-bodies";

export type LinkedInCardActionType = "update_ad" | "create_ad" | "pause_ad" | "other";
export const LINKEDIN_CHANGE_CARDS: Record<string, { build: (body: unknown) => { title: string; card: Record<string, unknown> }; actionType: LinkedInCardActionType }> = {
  [LINKEDIN_RESUME_CLASS]: { build: (b) => buildLinkedInResumeCardBody(linkedinResumeBodySchema.parse(b)), actionType: "update_ad" },
  [LINKEDIN_BUDGET_CLASS]: { build: (b) => buildLinkedInBudgetCardBody(linkedinBudgetBodySchema.parse(b)), actionType: "update_ad" },
  [LINKEDIN_TARGETING_CLASS]: { build: (b) => buildLinkedInTargetingCardBody(linkedinTargetingBodySchema.parse(b)), actionType: "update_ad" },
  [LINKEDIN_CAMPAIGN_EDIT_CLASS]: { build: (b) => buildLinkedInCampaignEditCardBody(linkedinCampaignEditBodySchema.parse(b)), actionType: "update_ad" },
  [LINKEDIN_GROUP_EDIT_CLASS]: { build: (b) => buildLinkedInGroupEditCardBody(linkedinGroupEditBodySchema.parse(b)), actionType: "update_ad" },
  [LINKEDIN_ARCHIVE_CLASS]: { build: (b) => buildLinkedInArchiveCardBody(linkedinArchiveBodySchema.parse(b)), actionType: "other" },
  [LINKEDIN_AD_STATUS_CLASS]: { build: (b) => buildLinkedInAdStatusCardBody(linkedinAdStatusBodySchema.parse(b)), actionType: "update_ad" },
  [LINKEDIN_CREATE_AD_CLASS]: { build: (b) => buildLinkedInCreateAdCardBody(linkedinCreateAdBodySchema.parse(b)), actionType: "create_ad" },
  [LINKEDIN_SWAP_AD_CLASS]: { build: (b) => buildLinkedInSwapAdCardBody(linkedinSwapAdBodySchema.parse(b)), actionType: "create_ad" },
  [LINKEDIN_CREATE_CAMPAIGN_CLASS]: { build: (b) => buildLinkedInCreateCampaignCardBody(linkedinCreateCampaignBodySchema.parse(b)), actionType: "create_ad" },
  [LINKEDIN_DUPLICATE_CLASS]: { build: (b) => buildLinkedInDuplicateCardBody(linkedinDuplicateBodySchema.parse(b)), actionType: "create_ad" },
};
const CHANGE_CARDS = LINKEDIN_CHANGE_CARDS;

import { LINKEDIN_SET_STATUS_CLASS, linkedinManagerLink } from "./_change-bodies";
export { LINKEDIN_SET_STATUS_CLASS };
const SWITCHED_LINKEDIN_CHANNELS: ReadonlySet<string> = new Set([
  "linkedin_ads",
]);

export type LinkedInStatusBody = {
  campaign_id: string;
  account_id: string;
  status: "PAUSED";
  name: string;
  rationale: string;
  funding_source?: "wallet";
};

export function buildLinkedInExecCardBody(body: LinkedInStatusBody): {
  title: string;
  card: Record<string, unknown>;
} {
  const title = `Pause the LinkedIn campaign "${body.name}"`.slice(0, 300);
  const wallet = body.funding_source === "wallet";
  const sentence = wallet
    ? `Zavi pauses "${body.name}", which runs in Zavi's shared LinkedIn ad account and is paid from your Zavi wallet. It stops spending until you launch it again from Zavi.`
    : `Zavi pauses "${body.name}" in LinkedIn Campaign Manager. It stops spending until someone turns it back on.`;
  return {
    title,
    card: {
      step: {
        title,
        body: [sentence, body.rationale.trim()].filter(Boolean).join("\n\n"),
        blocking: false,
        effort: "minutes",
        evidence: [],
      },
      change_sentence: sentence,
      exact_change: {
        rows: [
          {
            item: `Campaign "${body.name}"`,
            before: "Active",
            after: "Paused",
          },
        ],
      },
      decision_evidence: null,
      link: wallet ? "/channels/linkedin_ads" : linkedinManagerLink(body.account_id, body.campaign_id),
    },
  };
}

export function buildLinkedInLaunchCardBody(body: z.infer<typeof linkedinLaunchBody>): {
  title: string;
  card: Record<string, unknown>;
} {
  const title = `Launch LinkedIn campaign ${body.name}`.slice(0, 300);
  const total = new Intl.NumberFormat("en-US", { style: "currency", currency: body.currency }).format(body.total_budget_cents / 100);
  const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    body.total_budget_usd * (1 - Math.min(body.spent_so_far_cents ?? 0, body.total_budget_cents) / body.total_budget_cents),
  );
  const end = new Date(body.end_time).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" });
  const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: body.currency }).format(cents / 100);
  const daily = money(body.daily_budget_cents ?? 0);
  const funding = body.funding_source === "wallet" ? "Your Zavi wallet" : "Billed by LinkedIn directly";
  const spent = body.spent_so_far_cents ? money(body.spent_so_far_cents) : null;
  const sentence = `Launches "${body.name}" in LinkedIn Ads with a ${total} total budget for the whole campaign, ending ${end} UTC. ${body.currency === "USD" ? `It counts ${usd}` : `It counts about ${usd}, converted using ExchangeRate-API daily rates (https://www.exchangerate-api.com),`} against your Zavi monthly ad budget.${spent ? ` It has already spent ${spent}, which the total includes.` : ""}${body.daily_budget_cents != null ? ` Its daily budget stays ${daily}.` : ""}${body.funding_source ? ` Paid from: ${funding}.` : ""}`;
  return {
    title,
    card: {
      step: {
        title,
        body: `${sentence}\n\n${body.rationale}`,
        blocking: false,
        effort: "minutes",
        evidence: [],
      },
      change_sentence: sentence,
      exact_change: {
        rows: [
          { item: "Campaign", before: "Paused", after: "Active" },
          { item: "Total budget", before: "As set in LinkedIn", after: total },
          { item: "End date", before: "As set in LinkedIn", after: `${end} UTC` },
          ...(body.daily_budget_cents != null ? [{ item: "Daily budget", before: daily, after: `${daily} (not changed)` }] : []),
          ...(body.funding_source ? [{ item: "Paid from", before: funding, after: funding }] : []),
          ...(spent ? [{ item: "Already spent", before: spent, after: spent }] : []),
        ],
      },
      link: "/channels/linkedin_ads",
    },
  };
}

export async function resolveLinkedInAdsEmit(
  ctx: ExecEmitCtx,
): Promise<EmitDecisionFn | undefined> {
  const emit = await resolveChannelExecEmit(
    SWITCHED_LINKEDIN_CHANNELS,
    ctx,
    async (a) => {
      if (a.decision_class === LINKEDIN_LAUNCH) {
        const { title, card } = buildLinkedInLaunchCardBody(linkedinLaunchBody.parse(a.body));
        const { id } = await recordChannelExecAction({
          tenantId: a.tenant_id,
          runId: a.run_id,
          channelSlug: a.channel_slug,
          execClass: a.decision_class,
          execPayload: a.body,
          actionType: "update_ad",
          title,
          body: card,
        });
        return id;
      }
      const change = CHANGE_CARDS[a.decision_class];
      if (change) {
        const { title, card } = change.build(a.body);
        const { id } = await recordChannelExecAction({
          tenantId: a.tenant_id,
          runId: a.run_id,
          channelSlug: a.channel_slug,
          execClass: a.decision_class,
          execPayload: a.body,
          actionType: change.actionType,
          title,
          body: card,
        });
        return id;
      }
      if (a.decision_class !== LINKEDIN_SET_STATUS_CLASS) {
        throw new ExpectedToolError(
          "channel_action_class_unknown",
          `Zavi does not know where a ${a.decision_class} proposal belongs on this channel, so nothing was written. This is a Zavi bug, not something to retry.`,
        );
      }
      const { id } = await fileLinkedInPauseCard({
        tenant_id: a.tenant_id,
        run_id: a.run_id,
        channel_slug: a.channel_slug,
        body: a.body as LinkedInStatusBody,
      });
      return id;
    },
  );
  if (emit !== ctx.emit_decision) return emit;
  return cgoLinkedInLaunchEmit(ctx);
}

export async function cgoLinkedInLaunchEmit(
  ctx: ExecEmitCtx,
  isCgoRun: typeof isUnstampedCgoRun = isUnstampedCgoRun,
): Promise<EmitDecisionFn | undefined> {
  const legacy = ctx.emit_decision;
  if (!legacy || !ctx.run_id) return undefined;
  if (!(await readsAsCgoRun(ctx.tenant_id, ctx.run_id, isCgoRun))) return undefined;
  return async (decision_class, body) => {
    if (decision_class !== LINKEDIN_LAUNCH) {
      throw new ExpectedToolError("linkedin_ads_propose_not_channel_run", "This LinkedIn change is proposed on a LinkedIn Ads channel run. Nothing was proposed.");
    }
    return legacy(decision_class, body);
  };
}

export async function fileLinkedInPauseCard(
  a: { tenant_id: string; run_id: string; channel_slug: string; body: LinkedInStatusBody },
  deps?: ExecMatchDeps,
): Promise<ExecActionResult> {
  const { title, card } = buildLinkedInExecCardBody(a.body);
  const input = {
    tenantId: a.tenant_id,
    runId: a.run_id,
    channelSlug: a.channel_slug,
    execClass: LINKEDIN_SET_STATUS_CLASS,
    execPayload: a.body,
    actionType: "pause_ad" as const,
    title,
    body: card,
  };
  return deps ? recordChannelExecAction(input, undefined, deps) : recordChannelExecAction(input);
}
