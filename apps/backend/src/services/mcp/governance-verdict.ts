
import { isSideEffectingTool } from "./tool-effect-classifier";

export type Autonomy = "auto" | "approval" | "forbidden";

export type GovernanceVerdict = {
  governed: boolean;
  decision_class: string | null;
  mapped: boolean;
  self_governed?: true;
};

export const GOVERNED_EXTERNAL_SERVERS: ReadonlySet<string> = new Set([
  "slack",
  "email",
  "jira",
  "linear",
  "github",
  "stripe",
]);

const TOOL_DECISION_CLASS_MAP = {
  "slack__post_message": "slack.teammate_message",
  "slack__open_dm": "slack.teammate_message",
  "slack__upload_file": "slack.teammate_message",
  "email__send": "send_email",
  "jira__create_issue": "create_jira_issue",
  "jira__add_comment": "jira.add_comment",
  "linear__create_issue": "linear.create_issue",
  "linear__add_comment": "linear.add_comment",
  "github__open_pr": "github.open_pr_direct",
  "github__push_to_main": "github.open_pr_direct",
  "github__squash_merge": "github.merge_pr_direct",
  "stripe__create_payment": "stripe.create_payment",
  "stripe__remit_to_tenant": "stripe.remit_to_tenant",
  "stripe__submit_dispute_evidence": "dispute-response.submit-evidence",
  "stripe__create_connected_account": "stripe.create_connected_account",
} as const satisfies Record<string, string>;
export type GovernedToolKey = keyof typeof TOOL_DECISION_CLASS_MAP;
export const TOOL_DECISION_CLASS: Readonly<Record<string, string>> = TOOL_DECISION_CLASS_MAP;

export const CLASS_DEFAULT_AUTONOMY: Readonly<Record<string, Autonomy>> = {
  "slack.teammate_message": "auto",
  "send_email": "approval",
  "create_jira_issue": "approval",
  "jira.add_comment": "approval",
  "linear.create_issue": "approval",
  "linear.add_comment": "approval",
  "github.open_pr_direct": "approval",
  "github.merge_pr_direct": "approval",
  "stripe.create_payment": "approval",
  "stripe.remit_to_tenant": "approval",
  "dispute-response.submit-evidence": "approval",
  "stripe.create_connected_account": "approval",
};

export const SELF_GOVERNED_PROPOSALS: Readonly<Record<`${string}__propose_${string}`, string>> = {
  email__propose_campaign:
    "Files the email card (email_campaign.create_and_send or bulk_outbound.send) and sends nothing. The send runs only after an owner or admin approves that card (approve_email_card, enforced by the email-send guard triggers) or Autopilot approves it inside the Auto send limits.",
};

export type ReadCheck = (server_id: string, tool_name: string) => boolean;

export function resolveGovernanceVerdict(
  server_id: string,
  tool_name: string,
  isInternalServer: (server_id: string) => boolean,
  isRemoteRead?: ReadCheck,
): GovernanceVerdict {
  const key = `${server_id}__${tool_name}`;

  if (!isInternalServer(server_id)) {
    const isRead = isRemoteRead ? isRemoteRead(server_id, tool_name) : false;
    if (isRead) return { governed: false, decision_class: null, mapped: false };
    return { governed: true, decision_class: TOOL_DECISION_CLASS[key] ?? null, mapped: key in TOOL_DECISION_CLASS };
  }

  if (!GOVERNED_EXTERNAL_SERVERS.has(server_id)) {
    return { governed: false, decision_class: null, mapped: false };
  }
  if (!isSideEffectingTool(server_id, tool_name)) {
    return { governed: false, decision_class: null, mapped: false };
  }
  if (key in SELF_GOVERNED_PROPOSALS) {
    return { governed: false, decision_class: null, mapped: false, self_governed: true };
  }
  return {
    governed: true,
    decision_class: TOOL_DECISION_CLASS[key] ?? null,
    mapped: key in TOOL_DECISION_CLASS,
  };
}
