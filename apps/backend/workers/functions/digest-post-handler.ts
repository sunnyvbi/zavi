
import { logEvent } from "@/services/logging/logEvent";
import { callMcpTool } from "@/services/mcp/execute";
import { resolveZaviChannel } from "@/services/slack/resolve-zavi-channel";
import { mdToMrkdwn } from "@/services/tools/slack/mrkdwn";

export type DigestDecision = {
  id: string;
  tenant_id: string;
  agent_run_id: string | null;
  body: Record<string, unknown>;
};

const SLACK_TEXT_CAP = 2900;

export function renderDigestText(body: unknown): string {
  const b = body as { rendered_markdown?: unknown } | null | undefined;
  if (b && typeof b.rendered_markdown === "string" && b.rendered_markdown.trim()) {
    return mdToMrkdwn(b.rendered_markdown.trim()).slice(0, SLACK_TEXT_CAP);
  }
  try {
    return ("```\n" + JSON.stringify(body, null, 2).slice(0, SLACK_TEXT_CAP - 8) + "\n```");
  } catch {
    return "(digest payload unavailable)";
  }
}

export async function digestPostHandler(
  d: DigestDecision,
): Promise<{ ok: boolean; error?: string }> {
  const runId = d.agent_run_id ?? "";
  const channelId = await resolveZaviChannel(d.tenant_id, runId);

  if (!channelId) {
    await logEvent({
      level: "warn",
      source: "digest.post",
      code: "digest_no_zavi_channel",
      message: "no #zavi channel — digest not delivered (readable in Needs you)",
      tenant_id: d.tenant_id,
      run_id: d.agent_run_id,
      meta: { code: "no_zavi_channel" },
    });
    return { ok: true };
  }

  const text = renderDigestText(d.body);
  const r = await callMcpTool(
    { tenant_id: d.tenant_id, run_id: runId },
    "slack",
    "post_message",
    { channel_id: channelId, text },
  );

  if (r.is_error) {
    await logEvent({
      level: "warn",
      source: "digest.post",
      code: "digest_slack_post_failed",
      message: "slack post_message failed — digest not delivered",
      tenant_id: d.tenant_id,
      run_id: d.agent_run_id,
      meta: { code: "slack_post_failed" },
    });
    return { ok: true };
  }

  return { ok: true };
}
