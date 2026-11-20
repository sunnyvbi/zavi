
import { slackFetch } from "@/services/tools/slack/_client";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { proposeRule, type ProposedRule } from "./propose";

export const SLACK_ACTION_RULE_SAVE = "rule_save";
export const SLACK_ACTION_RULE_DISMISS = "rule_dismiss";

export function buildRuleSuggestionBlocks(rule: ProposedRule): unknown[] {
  const safe = rule.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return [
    { type: "section", text: { type: "mrkdwn", text: `*Keep this as a rule?*\n“${safe}”` } },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "An owner or admin can save it. Saved rules are on Settings → Rules in Zavi.",
        },
      ],
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: SLACK_ACTION_RULE_SAVE,
          style: "primary",
          text: { type: "plain_text", text: "Save rule" },
          value: rule.rule_id,
        },
        {
          type: "button",
          action_id: SLACK_ACTION_RULE_DISMISS,
          text: { type: "plain_text", text: "Not a rule" },
          value: rule.rule_id,
        },
      ],
    },
  ];
}

export async function suggestRuleFromSlackRun(args: {
  tenantId: string;
  runId: string;
  channelId: string;
  threadTs: string;
  teamId?: string;
}): Promise<ProposedRule | null> {
  try {
    const { data } = await tenantClient(asTenantId(args.tenantId))
      .from("agent_runs")
      .select("agent_slug, trigger, payload")
      .eq("id", args.runId)
      .maybeSingle();
    const run = data as { agent_slug: string; trigger: string; payload: { slack?: { text?: unknown } } | null } | null;
    const text = run?.trigger === "slack" ? run.payload?.slack?.text : null;
    if (typeof text !== "string" || !text) return null;
    const rule = await proposeRule({
      tenantId: args.tenantId,
      sourceKind: "slack_run",
      sourceId: args.runId,
      sourceText: text,
      agentSlug: run?.agent_slug ?? null,
      runId: args.runId,
    });
    if (!rule) return null;
    await slackFetch(
      args.tenantId,
      "chat.postMessage",
      {
        channel: args.channelId,
        thread_ts: args.threadTs,
        text: `Keep this as a rule? "${rule.text}"`,
        blocks: JSON.stringify(buildRuleSuggestionBlocks(rule)),
      },
      args.teamId,
    );
    return rule;
  } catch (e) {
    console.warn(`[rules] slack suggestion for run ${args.runId} failed: ${(e as Error).message}`);
    return null;
  }
}
