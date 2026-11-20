
import { z } from "zod";
import {
  setStatusBodySchema,
  updateAdSetBudgetBodySchema,
  updateCampaignBudgetBodySchema as metaUpdateCampaignBudgetBodySchema,
} from "@/services/tools/meta-ads/write/_decision-bodies";
import {
  googleSetStatusBodySchema,
  updateCampaignBudgetBodySchema,
} from "@/services/tools/google-ads/write/_decision-bodies";
import { readLinkedInSnapshot } from "@/services/connectors/linkedin-ads/outcome-snapshot";
import {
  recordActionOutcome,
  enrichBaseline,
  readMetaSnapshot,
  readGoogleSnapshot,
} from "@/services/growth/action-outcomes";

const MEASUREMENT_WINDOW_DAYS = 14;
const PR_WINDOW_DAYS = 7;
const EMAIL_WINDOW_DAYS = 1;

function baseClass(decisionClass: string): string {
  return decisionClass.replace(/_(auto|review)$/, "");
}

type Subject = {
  subject_type: "campaign" | "adset" | "ad" | "pr" | "email";
  subject_id: string;
  outcome_tier: "business" | "delivery";
  target_metric: string;
  window_days: number;
};

const shipPrSubjectSchema = z.object({
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  head_branch: z.string().min(1).max(120),
});

const DELIVERY_EMAIL_CLASSES = new Set(["outbound.send", "email.send", "gmail.send"]);

const LINKEDIN_CAMPAIGN_CLASSES = new Set(["linkedin_ads.set_status", "linkedin_ads.resume_campaign", "linkedin_ads.update_campaign_budget"]);
const linkedinCampaignBodySchema = z.object({ campaign_id: z.string().regex(/^\d{1,20}$/) });

function deriveSubject(
  decisionClass: string,
  decisionId: string,
  body: unknown,
): Subject | null {
  const base = baseClass(decisionClass);
  if (base === "meta_ads.set_status") {
    const parsed = setStatusBodySchema.safeParse(body);
    if (!parsed.success) return null;
    return {
      subject_type: parsed.data.level === "campaign" ? "campaign" : "adset",
      subject_id: parsed.data.object_id,
      outcome_tier: "business",
      target_metric: "spend",
      window_days: MEASUREMENT_WINDOW_DAYS,
    };
  }
  if (base === "meta_ads.update_ad_set_budget") {
    const parsed = updateAdSetBudgetBodySchema.safeParse(body);
    if (!parsed.success) return null;
    return {
      subject_type: "adset",
      subject_id: parsed.data.ad_set_id,
      outcome_tier: "business",
      target_metric: "spend",
      window_days: MEASUREMENT_WINDOW_DAYS,
    };
  }
  if (base === "meta_ads.update_campaign_budget") {
    const parsed = metaUpdateCampaignBudgetBodySchema.safeParse(body);
    if (!parsed.success) return null;
    return {
      subject_type: "campaign",
      subject_id: parsed.data.campaign_id,
      outcome_tier: "business",
      target_metric: "spend",
      window_days: MEASUREMENT_WINDOW_DAYS,
    };
  }
  if (LINKEDIN_CAMPAIGN_CLASSES.has(base)) {
    const parsed = linkedinCampaignBodySchema.safeParse(body);
    if (!parsed.success) return null;
    return {
      subject_type: "campaign",
      subject_id: parsed.data.campaign_id,
      outcome_tier: "business",
      target_metric: "spend",
      window_days: MEASUREMENT_WINDOW_DAYS,
    };
  }
  if (base === "google_ads.set_status") {
    const parsed = googleSetStatusBodySchema.safeParse(body);
    if (!parsed.success) return null;
    return {
      subject_type: "campaign",
      subject_id: parsed.data.campaign_id,
      outcome_tier: "business",
      target_metric: "spend",
      window_days: MEASUREMENT_WINDOW_DAYS,
    };
  }
  if (base === "google_ads.update_campaign_budget") {
    const parsed = updateCampaignBudgetBodySchema.safeParse(body);
    if (!parsed.success) return null;
    return {
      subject_type: "campaign",
      subject_id: parsed.data.campaign_id,
      outcome_tier: "business",
      target_metric: "spend",
      window_days: MEASUREMENT_WINDOW_DAYS,
    };
  }
  if (base === "engineer.ship-pr") {
    const parsed = shipPrSubjectSchema.safeParse(body);
    if (!parsed.success) return null;
    return {
      subject_type: "pr",
      subject_id: `${parsed.data.repo}#${parsed.data.head_branch}`,
      outcome_tier: "delivery",
      target_metric: "pr_state",
      window_days: PR_WINDOW_DAYS,
    };
  }
  if (DELIVERY_EMAIL_CLASSES.has(base)) {
    return {
      subject_type: "email",
      subject_id: decisionId,
      outcome_tier: "delivery",
      target_metric: "delivered",
      window_days: EMAIL_WINDOW_DAYS,
    };
  }
  return null;
}

export async function bindActionOutcome(args: {
  decisionId: string;
  tenantId: string;
  decisionClass: string;
  decisionOutcome: "approved" | "rejected";
  body: unknown;
}): Promise<void> {
  const subject = deriveSubject(args.decisionClass, args.decisionId, args.body);
  if (!subject) return;

  if (subject.outcome_tier === "delivery" && args.decisionOutcome !== "approved") return;

  const base = baseClass(args.decisionClass);

  const id = await recordActionOutcome({
    decisionId: args.decisionId,
    actionClass: base,
    decisionOutcome: args.decisionOutcome,
    subjectType: subject.subject_type,
    subjectId: subject.subject_id,
    targetMetric: subject.target_metric,
    measurementWindowDays: subject.window_days,
    outcomeTier: subject.outcome_tier,
  });
  if (id == null) return;

  if (subject.outcome_tier === "delivery") {
    await enrichBaseline({ id, status: "no_data" });
    return;
  }

  const readSnapshot = base.startsWith("google_ads.") ? readGoogleSnapshot : base.startsWith("linkedin_ads.") ? readLinkedInSnapshot : readMetaSnapshot;
  const until = ymd(new Date());
  const sinceDate = new Date();
  sinceDate.setUTCDate(sinceDate.getUTCDate() - subject.window_days);
  const since = ymd(sinceDate);
  try {
    const snap = await readSnapshot(args.tenantId, subject.subject_id, since, until);
    if (!snap) {
      await enrichBaseline({ id, status: "no_data" });
      return;
    }
    await enrichBaseline({
      id,
      status: "enriched",
      baselineMetrics: snap as unknown as Record<string, unknown>,
    });
  } catch (e) {
    await enrichBaseline({ id, status: "error", error: (e as Error).message });
  }
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}
