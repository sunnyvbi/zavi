import { asTenantId, tenantClient } from "@/services/tenant-client";
import { ExpectedToolError } from "@/services/tools/types";
import { LINKEDIN_SET_STATUS_CLASS, fileLinkedInPauseCard } from "@/services/tools/linkedin-ads/_exec-action";
import { readLinkedInPauseBody } from "@/services/tools/linkedin-ads/propose_pause_campaign";
import { openChannelCards } from "@/services/growth/pending-test-claim";

const CHANNEL = "linkedin_ads";
export const FOUNDER_PAUSE_RUN_STAGE = "linkedin_ads_founder_pause";
const FOUNDER_RATIONALE = "You asked Zavi to pause this campaign from the LinkedIn Ads channel page.";

export async function insertFounderRun(tenant_id: string, now: Date, stage: string, output_text: string): Promise<string> {
  const at = now.toISOString();
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("agent_runs")
    .insert({
      agent_slug: CHANNEL,
      channel_slug: CHANNEL,
      agent_definition_hash: stage,
      trigger: "manual",
      status: "success",
      enqueued_at: at,
      started_at: at,
      finished_at: at,
      parse_ok: true,
      cost_tokens: 0,
      cost_usd: 0,
      tool_calls: [],
      output_text,
      payload: { stage },
    })
    .select("id");
  if (error) throw new Error(`linkedin founder run: insert failed: ${error.message}`);
  const id = (data as Array<{ id?: string }> | null)?.[0]?.id;
  if (typeof id !== "string" || !id) throw new Error("linkedin founder run: insert returned no id");
  return id;
}

const pauseAlreadyWaiting = () =>
  new ExpectedToolError(
    "linkedin_ads_pause_pending",
    "A pause for this campaign is already waiting in Today. Approve or dismiss that one.",
  );

export async function proposeLinkedInPauseForFounder(
  tenant_id: string,
  input: { campaign_id: string; account_id: string },
  now: Date = new Date(),
): Promise<{ action_id: string; campaign: { id: string; name: string } }> {
  const open = await openChannelCards(tenant_id, CHANNEL, LINKEDIN_SET_STATUS_CLASS);
  if (open.some((c) => c.exec_payload?.campaign_id === input.campaign_id)) throw pauseAlreadyWaiting();
  const body = await readLinkedInPauseBody(tenant_id, { ...input, rationale: FOUNDER_RATIONALE });
  const run_id = await insertFounderRun(tenant_id, now, FOUNDER_PAUSE_RUN_STAGE, "The founder asked Zavi to pause a LinkedIn campaign (no model run).");
  const filed = await fileLinkedInPauseCard({ tenant_id, run_id, channel_slug: CHANNEL, body }, { enabled: () => false });
  if (filed.kept) throw pauseAlreadyWaiting();
  return { action_id: filed.id, campaign: { id: body.campaign_id, name: body.name } };
}
