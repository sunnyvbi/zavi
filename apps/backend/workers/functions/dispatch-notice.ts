
import { hasInternalJargon } from "@/services/agents/internal-jargon";

export const BULK_OUTBOUND_NOT_SENT_LINE =
  "Not sent: bulk email is not switched on yet, so nobody was emailed.";

export const BULK_OUTBOUND_INVALID_LINE =
  "Not sent: this bulk email draft was incomplete, so nobody was emailed.";

export const BULK_OUTBOUND_INTERRUPTED_LINE =
  "This bulk email was interrupted part-way. Some people may already have been emailed. Nobody will be emailed twice.";

export function bulkNotSentLine(sentence: string): string {
  const s = sentence.trim();
  return s.startsWith("Not sent:") || s.startsWith("Not confirmed:") ? s : `Not sent: ${s} Nobody was emailed.`;
}

export const HANDLER_LABELS: Record<string, string> = {
  "github.open_pr": "open the pull request",
  "github.merge_pr": "merge the pull request",
  "github.post_review": "post the PR review",
  "github.request_changes": "request changes on the PR",
  "jira.create_issue": "create the Jira issue",
  "jira.add_comment": "add the Jira comment",
  "linear.create_issue": "create the Linear issue",
  "linear.add_comment": "add the Linear comment",
  "slack.post_message": "post the Slack message",
  "email.send": "send the email",
  "outbound.send": "send the email",
  "bulk_outbound.send": "send the bulk email",
  "gmail.send": "send the email",
  "meta_ads.update_ad_set_budget": "update the ad-set budget",
  "meta_ads.update_ad_set_budget_review": "update the ad-set budget",
  "meta_ads.update_campaign_budget": "update the Meta campaign budget",
  "meta_ads.update_campaign_budget_review": "update the Meta campaign budget",
  "meta_ads.create_campaign": "create the Meta campaign",
  "meta_ads.launch_campaign": "launch the Meta campaign",
  "meta_ads.update_campaign": "update the Meta campaign",
  "meta_ads.delete_campaign": "delete the Meta campaign",
  "meta_ads.update_ad_set": "update the Meta ad set",
  "meta_ads.update_ad": "update the Meta ad",
  "meta_ads.duplicate_ad": "copy the Meta ad",
  "meta_ads.create_creative": "create the Meta creative",
  "meta_ads.update_creative": "rename the Meta creative",
  "meta_ads.upload_asset": "upload to the Meta ad account",
  "meta_ads.create_lookalike_audience": "build the Meta lookalike audience",
  "meta_ads.create_custom_conversion": "create the Meta custom conversion",
  "meta_ads.create_lead_form": "create the lead form",
  "meta_ads.set_status": "update the campaign status",
  "meta_ads.set_status_review": "update the campaign status",
  "meta_ads.pause_past_cut_guard": "pause the Meta ad set",
  "meta_ads.create_ad_set": "create the ad set",
  "google_ads.update_campaign_budget": "update the campaign budget",
  "google_ads.update_campaign_budget_review": "update the campaign budget",
  "google_ads.set_status": "update the Google Ads status",
  "google_ads.set_status_review": "update the Google Ads status",
  "google_ads.create_campaign": "create the Google Ads campaign",
  "google_ads.update_campaign": "update the Google Ads campaign",
  "google_ads.create_ad_group": "create the ad group",
  "google_ads.update_ad_group": "update the ad group",
  "google_ads.create_ad": "create the ad",
  "google_ads.add_keywords": "add the keywords",
  "google_ads.remove_resource": "remove the Google Ads resource",
  "google_ads.replace_geo_targets_review": "change where the Google Ads campaign shows",
  "meta_ads.replace_ad_set_geo_review": "change where the Meta ad set shows",
  "hiring.publish_role": "publish the role",
  "hiring.finalize_application": "finalize the application",
  "praxis.bake_rule": "bake the rule",
  "praxis.propose_global": "file the global-rule proposal",
  "social.publish.v2": "publish the social post",
};

export function extractChatThreadId(
  run: { trigger?: string | null; payload?: unknown } | null | undefined,
): string | null {
  if (!run || (run.trigger !== "chat" && run.trigger !== "a2a" && run.trigger !== "handoff")) return null;
  const payload = run.payload as { thread_id?: unknown; operator_thread_id?: unknown } | null | undefined;
  const keys = run.trigger === "handoff" ? (["thread_id", "operator_thread_id"] as const) : (["thread_id"] as const);
  for (const k of keys) {
    const tid = payload?.[k];
    if (typeof tid === "string" && tid.length > 0) return tid;
  }
  return null;
}

export type SlackRouting = {
  channel_id: string;
  thread_ts: string;
  team_id?: string;
};

export function extractSlackRouting(
  run: { trigger?: string | null; payload?: unknown } | null | undefined,
): SlackRouting | null {
  if (!run) return null;
  const payload = run.payload as
    | {
        slack?: { channel_id?: unknown; thread_ts?: unknown; team_id?: unknown };
        kind?: unknown;
        source?: unknown;
        slack_routing?: { channel_id?: unknown; thread_ts?: unknown; team_id?: unknown } | null;
      }
    | null
    | undefined;

  let block:
    | { channel_id?: unknown; thread_ts?: unknown; team_id?: unknown }
    | null
    | undefined;
  if (run.trigger === "slack") {
    block = payload?.slack;
  } else if (
    payload?.kind === "engineer_pr_followup" &&
    payload?.source === "slack" &&
    payload?.slack_routing
  ) {
    block = payload.slack_routing;
  } else {
    return null;
  }

  const channel_id = typeof block?.channel_id === "string" ? block.channel_id : "";
  const thread_ts = typeof block?.thread_ts === "string" ? block.thread_ts : "";
  if (!channel_id || !thread_ts) return null;
  const team_id = typeof block?.team_id === "string" && block.team_id.length > 0 ? block.team_id : undefined;
  return { channel_id, thread_ts, team_id };
}

export type OpenPrNoticeResult = {
  base: string;
  ok: boolean;
  pr_url?: string;
  pr_number?: number | null;
  error?: string;
};

export type OpenPrVerify = {
  status: "passed" | "failed" | "couldnt_run" | "not_run";
  reason?: string;
};

export function buildVerifyStatusLine(verify: OpenPrVerify | undefined): string {
  if (!verify) return "";
  switch (verify.status) {
    case "passed":
      return "✅ tests passed";
    case "couldnt_run": {
      const reason = verify.reason ? verify.reason.slice(0, 120) : "";
      const why = reason && !hasInternalJargon(reason) ? ` (${reason})` : "";
      return `Tests couldn't run here${why}. Check them in your CI or locally.`;
    }
    case "failed":
      return "Tests failed. See the PR.";
    case "not_run":
      return "🟡 tests not run";
    default:
      return "";
  }
}

export function buildOpenPrNotice(
  results: OpenPrNoticeResult[],
  opts: {
    repo: string;
    title: string;
    head_branch: string;
    supersededPrNumber?: number;
    verify?: OpenPrVerify;
  },
): string {
  const prefix =
    typeof opts.supersededPrNumber === "number"
      ? `♻️ PR #${opts.supersededPrNumber} is no longer open for follow-up (merged or closed) — opened a new PR with your changes instead.\n`
      : "";
  const opened = results.filter((r) => r.ok && r.pr_url);
  const alreadyOpen = results.filter((r) => r.ok && !r.pr_url && r.error === "already_open");
  const openedNoUrl = results.filter((r) => r.ok && !r.pr_url && r.error !== "already_open");
  const failed = results.filter((r) => !r.ok);

  const statusLine = buildVerifyStatusLine(opts.verify);
  const withStatus = (s: string): string => (statusLine ? `${s}\n${statusLine}` : s);

  if (opened.length === 1 && results.length === 1) {
    const r = opened[0];
    const ref = r.pr_number ? `${opts.repo}#${r.pr_number}` : "the PR";
    return withStatus(
      `${prefix}📬 Opened [${ref}](${r.pr_url}) — ${opts.title}\n\`${opts.head_branch}\` → \`${r.base}\``,
    );
  }

  const lines: string[] = [];
  if (opened.length > 0) {
    lines.push(`📬 Opened ${opened.length} PR${opened.length > 1 ? "s" : ""}:`);
    for (const r of opened) {
      const ref = r.pr_number ? `${opts.repo}#${r.pr_number}` : r.pr_url;
      lines.push(`• [${ref}](${r.pr_url}) → \`${r.base}\``);
    }
    if (statusLine) lines.push(statusLine);
  }
  if (openedNoUrl.length > 0) {
    const bases = openedNoUrl.map((r) => `\`${r.base}\``).join(", ");
    lines.push(
      `✅ Opened a PR on \`${opts.repo}\` for ${bases} — couldn't extract the link, check the repo's PR list.`,
    );
  }
  if (alreadyOpen.length > 0) {
    const bases = alreadyOpen.map((r) => `\`${r.base}\``).join(", ");
    lines.push(
      `ℹ️ Already open for ${bases} (re-dispatch detected) — check your GitHub PR list.`,
    );
  }
  if (failed.length > 0) {
    const detail = failed
      .map((r) => `\`${r.base}\` (${(r.error || "error").slice(0, 120)})`)
      .join(", ");
    lines.push(`Couldn't open for ${detail}.`);
  }
  return prefix + lines.join("\n");
}

export type PartialReport = {
  attempted: number;
  total: number;
  succeeded: number;
  already_done: number;
  failed: number;
  missing?: string[];
  receipts?: string[];
};

export function partialReportIsComplete(p: PartialReport | undefined): boolean {
  if (!p) return true;
  if (p.attempted !== p.total) return false;
  if (p.succeeded + p.already_done !== p.total) return false;
  if (p.failed > 0) return false;
  if (p.missing && p.missing.length > 0) return false;
  return true;
}

export function renderPartialReport(p: PartialReport): string {
  const lines: string[] = [];
  const headline =
    p.attempted === p.total
      ? `Ran ${p.attempted} of ${p.total}.`
      : `Ran ${p.attempted} of ${p.total} (${p.total - p.attempted} not attempted).`;
  lines.push(headline);

  const parts: string[] = [];
  if (p.succeeded > 0) parts.push(`${p.succeeded} succeeded`);
  if (p.already_done > 0) parts.push(`${p.already_done} already done`);
  if (p.failed > 0) parts.push(`${p.failed} failed`);
  if (parts.length > 0) lines.push(parts.join(", ") + ".");

  const missing = p.missing ?? [];
  if (missing.length > 0) {
    const MAX = 8;
    const shown = missing.slice(0, MAX).join(", ");
    const more = missing.length > MAX ? `, +${missing.length - MAX} more` : "";
    lines.push(`Missing: ${shown}${more}.`);
  }

  return lines.join("\n");
}

export function buildDispatchNotice(input: {
  handler: string | null;
  ok: boolean;
  error?: string;
  notice?: string;
  partial_report?: PartialReport;
  outcome_unknown?: boolean;
}): string {
  if (input.ok) {
    const n = input.notice?.trim();
    const p = input.partial_report;
    if (p && !partialReportIsComplete(p)) {
      const breakdown = renderPartialReport(p);
      return n && n.length > 0 ? `${breakdown}\n\n${n}` : breakdown;
    }
    return n && n.length > 0 ? n : "✅ Done.";
  }
  if (input.handler === "bulk_outbound.send" && input.error?.startsWith(BULK_OUTBOUND_INVALID_LINE)) {
    return `${BULK_OUTBOUND_INVALID_LINE} Ask the agent to draft it again.`;
  }
  if (input.handler === "bulk_outbound.send") {
    const err = (input.error ?? "").replace(/\s*\([a-z_]+\)\s*$/, "").trim();
    if (err.startsWith(BULK_OUTBOUND_INTERRUPTED_LINE)) return BULK_OUTBOUND_INTERRUPTED_LINE;
    if (!err || err.startsWith(BULK_OUTBOUND_NOT_SENT_LINE)) {
      return `${BULK_OUTBOUND_NOT_SENT_LINE} This draft was written before Zavi could send bulk email, and retrying won't change that. Ask the agent to propose it again, to one of your contact lists.`;
    }
    if (err.startsWith("Not sent:") || err.startsWith("Not confirmed:")) return err;
    return bulkNotSentLine("Something went wrong before the first email.");
  }
  if (input.handler === "outbound.send" && input.outcome_unknown && input.error?.trim()) return input.error.trim();
  const label = (input.handler && HANDLER_LABELS[input.handler]) || "complete this action";
  const err = (input.error || "unknown error").slice(0, 400);
  if (input.handler === "composio.execute_tool" && /invalid request data|missing required|fields are missing|composio_invalid_arguments/i.test(input.error ?? "")) {
    return `Couldn't ${label}: ${err}\n\nThe request failed validation. Correct the required inputs before trying again; approving or retrying the same request will not fix it.`;
  }
  return `Couldn't ${label}: ${err}\n\nThe decision is recorded — tell me to retry, or open the card in Zavi.`;
}
