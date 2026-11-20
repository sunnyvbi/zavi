
import { serviceClient } from "@/services/supabase";
import { jiraAddComment } from "@/services/mcp/internal/jira";
import { linearAddComment } from "@/services/mcp/internal/linear";
import { resolveTrackerOrigin, type TrackerRef } from "./tracker-origin";

async function trackerEnablement(
  tenant_id: string,
): Promise<{ jira: boolean; linear: boolean }> {
  const { data, error } = await serviceClient()
    .from("tenant_mcp_servers")
    .select("server_id, enabled")
    .eq("tenant_id", tenant_id)
    .in("server_id", ["jira", "linear"]);
  if (error) {
    console.warn(
      `[tracker-pr-comment] enablement read failed for ${tenant_id}: ${error.message}`,
    );
    return { jira: false, linear: false };
  }
  let jira = false;
  let linear = false;
  for (const row of (data ?? []) as Array<{
    server_id?: string;
    enabled?: boolean;
  }>) {
    if (row.server_id === "jira" && row.enabled === true) jira = true;
    if (row.server_id === "linear" && row.enabled === true) linear = true;
  }
  return { jira, linear };
}

async function postComment(
  tenant_id: string,
  ref: TrackerRef,
  body_markdown: string,
): Promise<void> {
  if (ref.connector === "jira") {
    await jiraAddComment(
      tenant_id,
      { issue_key: ref.key, body_markdown },
      { agentAuto: true },
    );
  } else {
    await linearAddComment(
      tenant_id,
      { issue_id: ref.key, body_markdown },
      { agentAuto: true },
    );
  }
}

export type TrackerPrEvent = "opened" | "merged";

export async function postTrackerPrComment(args: {
  tenant_id: string;
  originText: string;
  pr_url: string;
  event: TrackerPrEvent;
}): Promise<TrackerRef | null> {
  const { tenant_id, originText, pr_url, event } = args;
  if (!tenant_id || !pr_url) return null;
  try {
    const enabled = await trackerEnablement(tenant_id);
    if (!enabled.jira && !enabled.linear) return null;
    const ref = resolveTrackerOrigin(originText ?? "", enabled);
    if (!ref) return null;

    const body_markdown =
      event === "opened"
        ? `Zavi engineer opened a pull request for this ticket: ${pr_url}`
        : `Zavi engineer's pull request for this ticket was merged: ${pr_url}`;

    await postComment(tenant_id, ref, body_markdown);
    return ref;
  } catch (e) {
    console.warn(
      `[tracker-pr-comment] ${event} comment failed for tenant ${tenant_id} pr=${pr_url}: ${(e as Error).message}`,
    );
    return null;
  }
}
