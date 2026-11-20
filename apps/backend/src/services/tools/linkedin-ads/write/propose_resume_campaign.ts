import { z } from "zod";
import { ExpectedToolError, type ToolSpec } from "@/services/tools/types";
import { LINKEDIN_RESUME_CLASS, type LinkedInResumeBody } from "../_change-bodies";
import { readOwnCampaignTarget, requireChannelRun, emitLinkedInCard } from "./_own-target";

const inputSchema = z
  .object({
    campaign_id: z.string().regex(/^\d{1,20}$/, "campaign_id must be a bare numeric LinkedIn campaign id").describe("LinkedIn campaign id, from linkedin_ads_list_campaigns."),
    account_id: z.string().regex(/^\d{1,20}$/, "account_id must be a bare numeric LinkedIn ad-account id").describe("The ad account the campaign belongs to."),
    run_until: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe("New end date (UTC, YYYY-MM-DD, after today). Required for a COMPLETED campaign, which LinkedIn only restarts with a new end date; ignored for a PAUSED one unless its end date has passed."),
    rationale: z.string().min(1).max(500).describe("Why it should run again, citing the numbers you read (its results while it ran, what changed since it stopped)."),
  })
  .strict();

const ymd = (d: Date) => d.toISOString().slice(0, 10);

export async function readLinkedInResumeBody(tenant_id: string, args: z.infer<typeof inputSchema>, now = new Date()): Promise<LinkedInResumeBody> {
  const t = await readOwnCampaignTarget(tenant_id, args, "only its launch flow in Zavi can start it again");
  const label = t.name !== t.id ? `"${t.name}"` : "This campaign";
  if (t.status === "ACTIVE") throw new ExpectedToolError("linkedin_ads_campaign_active", `${label} is already running.`);
  if (t.status !== "PAUSED" && t.status !== "COMPLETED")
    throw new ExpectedToolError("linkedin_ads_campaign_not_restartable", `${label} is ${t.status ? t.status.toLowerCase() : "in an unknown state"}, which cannot be restarted. Only a paused or completed campaign can.`);
  let run_end_at: string | null = t.live.runSchedule?.end ? new Date(t.live.runSchedule.end).toISOString() : null;
  const endPassed = typeof t.live.runSchedule?.end === "number" && t.live.runSchedule.end <= now.getTime();
  if (t.status === "COMPLETED" || endPassed) {
    if (!args.run_until) throw new ExpectedToolError("linkedin_ads_end_date_required", `${label} ${t.status === "COMPLETED" ? "ended" : "is paused with an end date that has passed"}, and LinkedIn only restarts it with a new end date. Pass run_until (YYYY-MM-DD, after today).`);
    const end = Date.parse(`${args.run_until}T23:59:59.000Z`);
    if (Number.isNaN(end) || ymd(new Date(end)) !== args.run_until || end <= now.getTime()) throw new ExpectedToolError("linkedin_ads_end_date_passed", `run_until ${args.run_until} is not a calendar date after today (${ymd(now)}).`);
    run_end_at = new Date(end).toISOString();
  }
  const money = t.live.dailyBudget ? { kind: "daily" as const, ...t.live.dailyBudget } : t.live.totalBudget ? { kind: "total" as const, ...t.live.totalBudget } : null;
  return {
    campaign_id: t.id,
    account_id: args.account_id,
    name: t.name,
    rationale: args.rationale,
    expected_status: t.status,
    run_start_at: t.live.runSchedule?.start ? new Date(t.live.runSchedule.start).toISOString() : null,
    run_end_at,
    budget: money ? { kind: money.kind, amount: money.amount, currency: money.currencyCode } : null,
  };
}

export const linkedinAdsProposeResumeCampaignTool: ToolSpec = {
  name: "linkedin_ads_propose_resume_campaign",
  effect: "write",
  description:
    "Propose restarting one PAUSED or COMPLETED LinkedIn Ads campaign. Files a card on the LinkedIn Ads channel's Actions tab for the founder, or cgo on Autopilot with an ad budget, to approve. A completed campaign needs run_until, a new end date, because LinkedIn keeps the original start. A campaign in Zavi's shared ad account is refused: its launch flow restarts it. Only works on a linkedin_ads channel run.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const args = inputSchema.parse(input);
    requireChannelRun(ctx);
    const body = await readLinkedInResumeBody(ctx.tenant_id, args);
    const action_id = await emitLinkedInCard(ctx, LINKEDIN_RESUME_CLASS, body);
    return { action_id, status: "waiting_for_owner", campaign: { id: body.campaign_id, name: body.name, was: body.expected_status, run_until: body.run_end_at } };
  },
};
