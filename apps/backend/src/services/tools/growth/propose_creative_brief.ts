
import { z } from "zod";
import { tenantClient, asTenantId } from "@/services/tenant-client";
import { ExpectedToolError, type ToolSpec } from "@/services/tools/types";
import { CREATOR_MARKETPLACE_ENABLED } from "@zavi/shared";

const evidenceItem = z.object({
  claim: z
    .string()
    .min(1)
    .max(300)
    .describe("One measured observation, e.g. 'ad set 12: CTR fell 0.9%→0.4% over 14d'."),
  source: z
    .string()
    .min(1)
    .max(200)
    .describe("Where the claim came from, e.g. 'meta_ads__list_ads' or 'growth__read_ads_perf'."),
});

const inputSchema = z.object({
  title: z
    .string()
    .min(1)
    .max(200)
    .describe(
      "Creators read this on their Briefs page. Say what the video is in plain words, e.g. 'Film yourself trying the product for the first time'.",
    ),
  angle: z
    .string()
    .min(1)
    .max(600)
    .describe(
      "Creators read this. Speak to the creator as 'you': one sentence on what the business sells, then what to film, step by step, in plain words. No marketing or testing terms (angle, variable, body, takes, funnel).",
    ),
  hook: z
    .string()
    .min(1)
    .max(400)
    .describe(
      "The first line the creator says on camera, word for word. For several openings, number them 1., 2., 3. and add: 'Film each opening separately; the rest of the video stays the same.'",
    ),
  format: z
    .string()
    .min(1)
    .max(120)
    .describe("In plain words, e.g. 'Vertical video, 30 to 45 seconds, filmed on your phone, your face and your screen'."),
  deliverables: z.number().int().min(1).max(20).default(1).describe("How many assets."),
  rationale: z
    .string()
    .min(1)
    .max(1200)
    .describe("Why this brief, grounded in the evidence below."),
  evidence: z
    .array(evidenceItem)
    .min(1)
    .max(10)
    .describe("The measured observations the rationale rests on. At least one."),
  source_campaign_ref: z
    .string()
    .max(200)
    .default("")
    .describe("The campaign or ad set that fatigued, by name or id."),
  budget_usd: z
    .number()
    .nonnegative()
    .max(100000)
    .optional()
    .describe("Indicative creator budget for the operator. NOT a spend authorization."),
});

export const proposeCreativeBriefInputSchema = inputSchema;

const CREATOR_JARGON: Array<[RegExp, string]> = [
  [/\bone (testable )?variable\b|\btestable\b/i, "testing language"],
  [/\bhook takes?\b|\b\d+ takes? \+|\bsame body\b|\bone body\b/i, "'body' or 'takes'"],
  [/\bscreen and face\b/i, "production shorthand"],
  [/(^|[\s.;])[A-C] \([a-z ]{2,20}\):/, "internal labels like 'A (price):'"],
];

export function creatorFacingProblems(fields: { title: string; angle: string; hook: string; format: string }): string[] {
  const out: string[] = [];
  for (const [name, text] of Object.entries(fields)) {
    for (const [re, what] of CREATOR_JARGON) {
      if (re.test(text)) out.push(`${name}: ${what}`);
    }
  }
  return out;
}

export const DEFAULT_BRIEF_AD_RIGHTS_DAYS = 90;

export type CreativeBriefResult = {
  brief_id: string;
  utm_campaign: string;
  status: string;
  title: string;
  next_step: string;
};

export const proposeCreativeBriefTool: ToolSpec = {
  name: "growth_propose_creative_brief",
  effect: "write",
  description:
    "Write a creative brief from a fatigue diagnosis so the operator can commission the asset. " +
    "Returns a stable utm_campaign tag — the operator MUST put that tag on the shipped asset, " +
    "otherwise the result cannot be attributed later. Requires at least one piece of measured " +
    "evidence. Use this instead of ending a run at 'your creative is fatigued'.",
  input_schema: inputSchema,
  async execute(ctx, input): Promise<CreativeBriefResult> {
    const parsed = inputSchema.parse(input);
    const problems = creatorFacingProblems(parsed);
    if (problems.length > 0) {
      throw new ExpectedToolError(
        "brief_not_creator_facing",
        `Creators read the title, angle, hook and format on their Briefs page. Rewrite them in plain words addressed to the creator, then call again. Fix: ${problems.join("; ")}.`,
      );
    }

    const db = tenantClient(asTenantId(ctx.tenant_id));
    const { data, error } = await db
      .from("creator_briefs")
      .insert({
        status: "draft",
        title: parsed.title.trim(),
        angle: parsed.angle.trim(),
        hook: parsed.hook.trim(),
        format: parsed.format.trim(),
        deliverables: parsed.deliverables,
        rationale: parsed.rationale.trim(),
        evidence: parsed.evidence,
        source_campaign_ref: parsed.source_campaign_ref.trim(),
        source_run_id: ctx.run_id ?? null,
        budget_usd: parsed.budget_usd ?? null,
        lane: "ugc_video",
        ad_rights_days: DEFAULT_BRIEF_AD_RIGHTS_DAYS,
      })
      .select("id, utm_campaign, status, title")
      .single();

    if (error || !data) {
      ctx.log("creator_brief insert failed", { message: error?.message });
      throw new ExpectedToolError(
        "brief_write_failed",
        "Could not save the creative brief. Report the diagnosis and the brief text to the operator in your answer so the work is not lost.",
      );
    }

    const row = data as { id: string; utm_campaign: string; status: string; title: string };
    ctx.log("creator_brief created", { brief_id: row.id });

    return {
      brief_id: row.id,
      utm_campaign: row.utm_campaign,
      status: row.status,
      title: row.title,
      next_step: CREATOR_MARKETPLACE_ENABLED
        ? `This draft is now the card "Post this brief to Zavi creators: ${row.title}" on the UGC page, where the founder edits and posts it. Do not write a step for posting it. The delivered video carries utm_campaign=${row.utm_campaign}, which is how its result is separated later.`
        : `Assign this brief to the merchant's own team or an existing production partner. Zavi does not source or book outside creators. The delivered video carries utm_campaign=${row.utm_campaign}, which is how its result is separated later.`,
    };
  },
};
