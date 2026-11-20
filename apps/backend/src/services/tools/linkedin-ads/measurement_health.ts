import { z } from "zod";
import {
  associatedCampaignIds,
  msToIso,
  readLinkedInConversions,
  readLinkedInConversionsWithToken,
  readLinkedInInsightTagDomains,
  readLinkedInInsightTagDomainsWithToken,
  readLinkedInInsightTags,
  readLinkedInInsightTagsWithToken,
  type LiConversion,
  type LiInsightTag,
  type LiInsightTagDomain,
} from "@/services/connectors/linkedin-ads/account-reads";
import { listLinkedInCampaigns, type LinkedInAdCampaign } from "@/services/connectors/linkedin-ads/client";
import type { ToolSpec } from "@/services/tools/types";
import { linkedinJudgedOn } from "./_objective";
import { linkedinAccountAccess } from "./_wallet";
import { walletCampaigns } from "./list_campaigns";

const CAMPAIGN_LIST_LIMIT = 500;

export type LinkedInMeasurementStatus = "healthy" | "degraded" | "no_tag";
export type LinkedInEventCovered = "yes" | "no" | "not_needed" | "unknown";

export type LinkedInConversionHealth = {
  id: string;
  name: string | null;
  type: string | null;
  enabled: boolean;
  attribution_type: string | null;
  last_callback_at: string | null;
  last_callback_age_days: number | null;
  firing_in_window: boolean;
  campaign_ids: string[];
};

export type LinkedInCampaignCoverage = {
  campaign_id: string;
  campaign_name: string;
  status: string | null;
  objective: string | null;
  judged_on: ReturnType<typeof linkedinJudgedOn>;
  event_covered: LinkedInEventCovered;
  conversion_ids: string[];
  note: string;
};

const DAY_MS = 86_400_000;
const ageDays = (ms: number | undefined, now: Date): number | null => (typeof ms === "number" && Number.isFinite(ms) ? Math.max(0, Math.floor((now.getTime() - ms) / DAY_MS)) : null);
const within = (ms: number | undefined, now: Date, days: number): boolean => typeof ms === "number" && Number.isFinite(ms) && now.getTime() - ms <= days * DAY_MS;

export function gradeLinkedInMeasurement(
  input: { tags: LiInsightTag[]; domains: LiInsightTagDomain[] | null; conversions: LiConversion[]; campaigns: LinkedInAdCampaign[]; lookback_days: number; shared_account: boolean },
  now = new Date(),
): { overall_status: LinkedInMeasurementStatus; domains: Array<{ domain: string; last_callback_at: string | null; last_callback_age_days: number | null; firing_in_window: boolean; blocked: boolean }>; conversions: LinkedInConversionHealth[]; coverage: LinkedInCampaignCoverage[]; reasons: string[] } {
  const domains = (input.domains ?? []).map((d) => ({
    domain: d.domainName ?? "(unnamed)",
    last_callback_at: msToIso(d.lastCallbackAt),
    last_callback_age_days: ageDays(d.lastCallbackAt, now),
    firing_in_window: within(d.lastCallbackAt, now, input.lookback_days),
    blocked: d.blocked === true,
  }));
  const conversions: LinkedInConversionHealth[] = input.conversions.map((c) => {
    const last = typeof c.lastCallbackAt === "number" ? c.lastCallbackAt : c.latestFirstPartyCallbackAt;
    return {
      id: String(c.id ?? ""),
      name: c.name ?? null,
      type: c.type ?? null,
      enabled: c.enabled !== false,
      attribution_type: c.attributionType ?? null,
      last_callback_at: msToIso(last),
      last_callback_age_days: ageDays(last, now),
      firing_in_window: within(last, now, input.lookback_days),
      campaign_ids: associatedCampaignIds(c),
    };
  });
  const byCampaign = new Map<string, LinkedInConversionHealth[]>();
  for (const c of conversions) for (const id of c.campaign_ids) byCampaign.set(id, [...(byCampaign.get(id) ?? []), c]);
  const coverage: LinkedInCampaignCoverage[] = input.campaigns.map((c) => {
    const judged = linkedinJudgedOn(c.objective);
    const rules = byCampaign.get(c.id) ?? [];
    const live = rules.filter((r) => r.enabled && r.firing_in_window);
    let event_covered: LinkedInEventCovered;
    let note: string;
    if (judged === "reach_and_clicks") {
      event_covered = "not_needed";
      note = "This objective is judged on impressions, reach and clicks; a conversion rule is not what its numbers rest on.";
    } else if (judged === "unknown") {
      event_covered = rules.length ? (live.length ? "yes" : "no") : "unknown";
      note = rules.length ? (live.length ? "A conversion rule is attached and fired in the window." : "A conversion rule is attached but did not fire in the window.") : "The objective is not one Zavi can judge, and no conversion rule is attached.";
    } else if (!rules.length) {
      event_covered = "no";
      note = "Judged on conversions or leads, but no conversion rule is attached to this campaign, so its conversion and lead numbers rest on LinkedIn's lead forms alone or on nothing.";
    } else if (live.length) {
      event_covered = "yes";
      note = `${live.length} of ${rules.length} attached conversion rule(s) fired within the last ${input.lookback_days} days.`;
    } else {
      event_covered = "no";
      note = `${rules.length} conversion rule(s) are attached but none fired within the last ${input.lookback_days} days, so a zero here may be a tracking gap, not a result.`;
    }
    return { campaign_id: c.id, campaign_name: c.name, status: c.status, objective: c.objective, judged_on: judged, event_covered, conversion_ids: rules.map((r) => r.id), note };
  });
  const reasons: string[] = [];
  let overall_status: LinkedInMeasurementStatus;
  const anyDomainFiring = domains.some((d) => d.firing_in_window && !d.blocked);
  const anyDomainEver = domains.some((d) => d.last_callback_at !== null);
  const anyConversionFiring = conversions.some((c) => c.enabled && c.firing_in_window);
  if (input.shared_account) {
    overall_status = anyConversionFiring ? "healthy" : conversions.length ? "degraded" : "no_tag";
    reasons.push("This campaign runs in Zavi's shared LinkedIn ad account, whose Insight Tag belongs to Zavi; only the conversion rules attached to your campaigns are reported.");
    if (!anyConversionFiring) reasons.push(conversions.length ? `No attached conversion rule fired within the last ${input.lookback_days} days.` : "No conversion rule is attached to your campaigns.");
  } else if (!input.tags.length || (input.domains !== null && !anyDomainEver)) {
    overall_status = "no_tag";
    reasons.push(!input.tags.length ? "The account has no Insight Tag." : "The Insight Tag has never fired on any domain.");
  } else if (!anyDomainFiring && input.domains !== null) {
    overall_status = "degraded";
    reasons.push(`The Insight Tag fired on no domain within the last ${input.lookback_days} days.`);
  } else if (conversions.length && !anyConversionFiring) {
    overall_status = "degraded";
    reasons.push(`The tag fires but no enabled conversion rule fired within the last ${input.lookback_days} days.`);
  } else if (input.domains === null && !anyConversionFiring) {
    overall_status = "degraded";
    reasons.push("The tag's per-domain firing could not be read and no conversion rule has fired, so nothing shows the tag working.");
  } else {
    overall_status = "healthy";
    if (input.domains === null) reasons.push("The tag's per-domain firing could not be read; healthy rests on the conversion rules alone.");
    if (!conversions.length) reasons.push("The tag fires but the account has no conversion rule, so conversion columns are empty by construction.");
  }
  return { overall_status, domains, conversions, coverage, reasons };
}

const inputSchema = z
  .object({
    account_id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[1-9]\d*$/, "account_id must be a numeric LinkedIn ad-account id")
      .describe("LinkedIn Ads account id, from linkedin_ads_list_accounts."),
    lookback_days: z.number().int().min(1).max(90).default(7).describe("A tag domain or conversion rule counts as firing when its last callback is within this many days."),
  })
  .strict();

export const LINKEDIN_MEASUREMENT_METHOD =
  "LinkedIn exposes, per account, the Insight Tag, the domains it has fired on with the time of the last callback, and each conversion rule with its last callback and the campaigns it is attached to. Zavi reads those three lists, no page content and no visitor data. overall_status is about the tag and the rules, not about results: healthy means the tag fired on some domain and some enabled rule fired in the window; degraded means one of those stopped; no_tag means there is no tag or it never fired. event_covered says per campaign whether a conversion rule that fired in the window is attached to it. Report this; it never blocks a budget change on its own.";

export const linkedinAdsMeasurementHealthTool: ToolSpec = {
  name: "linkedin_ads_measurement_health",
  effect: "read",
  description:
    "Can the LinkedIn numbers be trusted? For one ad account, reads the Insight Tag, the domains it fired on (last callback) and every conversion rule (type, enabled, last callback, attached campaigns), then grades overall_status healthy / degraded / no_tag and says per campaign whether the event it is judged on is covered by a rule that fired in the window (event_covered yes / no / not_needed / unknown). Call it before reading conversions or leads as results, and report what it says; a degraded tag is a finding to state, never a reason to refuse a budget change. Read-only; nobody's name or visit is read.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const { account_id, lookback_days } = inputSchema.parse(input);
    const access = await linkedinAccountAccess(ctx.tenant_id, account_id);
    const campaigns = access.kind === "wallet" ? await walletCampaigns(ctx.tenant_id, access, CAMPAIGN_LIST_LIMIT) : await listLinkedInCampaigns(ctx.tenant_id, account_id, CAMPAIGN_LIST_LIMIT);
    const own = new Set(campaigns.map((c) => c.id));
    let tags: LiInsightTag[] = [];
    let domains: LiInsightTagDomain[] | null = null;
    let conversions: LiConversion[];
    if (access.kind === "wallet") {
      conversions = (await readLinkedInConversionsWithToken(access.token, account_id)).filter((c) => {
        const ids = associatedCampaignIds(c);
        return ids.length > 0 && ids.every((id) => own.has(id));
      });
    } else {
      const [t, d, c] = await Promise.all([
        readLinkedInInsightTags(ctx.tenant_id, account_id),
        readLinkedInInsightTagDomains(ctx.tenant_id, account_id).then((x) => x as LiInsightTagDomain[] | null, () => null),
        readLinkedInConversions(ctx.tenant_id, account_id),
      ]);
      tags = t;
      domains = d;
      conversions = c;
    }
    const graded = gradeLinkedInMeasurement({ tags, domains, conversions, campaigns, lookback_days, shared_account: access.kind === "wallet" });
    return {
      account_id,
      lookback_days,
      shared_account: access.kind === "wallet",
      overall_status: graded.overall_status,
      reasons: graded.reasons,
      insight_tag: { present: access.kind === "wallet" ? null : tags.length > 0, domains_readable: domains !== null, domains: graded.domains },
      conversions: graded.conversions,
      campaign_coverage: graded.coverage,
      counts: {
        domains: graded.domains.length,
        domains_firing: graded.domains.filter((d) => d.firing_in_window).length,
        conversions: graded.conversions.length,
        conversions_firing: graded.conversions.filter((c) => c.firing_in_window).length,
        campaigns_uncovered: graded.coverage.filter((c) => c.event_covered === "no").length,
      },
      method: LINKEDIN_MEASUREMENT_METHOD,
    };
  },
};
