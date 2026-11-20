import { ExpectedToolError } from "@/services/tools/types";
import { recordChannelExecAction } from "@/services/channels/exec-actions";
import { LINKEDIN_RESUME_CLASS, buildLinkedInResumeCardBody } from "@/services/tools/linkedin-ads/_change-bodies";
import { readLinkedInResumeBody } from "@/services/tools/linkedin-ads/write/propose_resume_campaign";
import { openChannelCards } from "@/services/growth/pending-test-claim";
import { insertFounderRun } from "./propose-pause";

const CHANNEL = "linkedin_ads";
export const FOUNDER_RESUME_RUN_STAGE = "linkedin_ads_founder_resume";
export const FOUNDER_RESUME_DAYS = 30;
const FOUNDER_RATIONALE = "You asked Zavi to restart this campaign from the LinkedIn Ads channel page.";

const resumeAlreadyWaiting = () =>
  new ExpectedToolError(
    "linkedin_ads_resume_pending",
    "A restart for this campaign is already waiting in Next steps. Approve or dismiss that one.",
  );

const ymd = (d: Date) => d.toISOString().slice(0, 10);

export function founderRunUntil(now: Date, days = FOUNDER_RESUME_DAYS): string {
  return ymd(new Date(now.getTime() + days * 86_400_000));
}

export async function proposeLinkedInResumeForFounder(
  tenant_id: string,
  input: { campaign_id: string; account_id: string; run_until?: string },
  now: Date = new Date(),
): Promise<{ action_id: string; campaign: { id: string; name: string; was: string; run_until: string | null } }> {
  const open = await openChannelCards(tenant_id, CHANNEL, LINKEDIN_RESUME_CLASS);
  if (open.some((c) => c.exec_payload?.campaign_id === input.campaign_id)) throw resumeAlreadyWaiting();
  const body = await readLinkedInResumeBody(tenant_id, { ...input, run_until: input.run_until ?? founderRunUntil(now), rationale: FOUNDER_RATIONALE }, now);
  const run_id = await insertFounderRun(tenant_id, now, FOUNDER_RESUME_RUN_STAGE, "The founder asked Zavi to restart a LinkedIn campaign (no model run).");
  const { title, card } = buildLinkedInResumeCardBody(body);
  const filed = await recordChannelExecAction(
    { tenantId: tenant_id, runId: run_id, channelSlug: CHANNEL, execClass: LINKEDIN_RESUME_CLASS, execPayload: body, actionType: "update_ad", title, body: card },
    undefined,
    { enabled: () => false },
  );
  if (filed.kept) throw resumeAlreadyWaiting();
  return { action_id: filed.id, campaign: { id: body.campaign_id, name: body.name, was: body.expected_status, run_until: body.run_end_at } };
}
