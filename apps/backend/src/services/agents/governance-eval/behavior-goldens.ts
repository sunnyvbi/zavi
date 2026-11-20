
import {
  resolveGovernanceVerdict,
  CLASS_DEFAULT_AUTONOMY,
  type Autonomy,
} from "@/services/mcp/governance-verdict";
import { INTERNAL_SERVERS } from "@/services/mcp/tool-effect-classifier";
import { selectRenderedText } from "../render-select";

const isInternalServer = (server_id: string): boolean =>
  INTERNAL_SERVERS.has(server_id);

export type CodeSideAutonomy = Autonomy | "ungoverned";

export function codeSideAutonomy(
  server_id: string,
  tool_name: string,
): CodeSideAutonomy {
  const verdict = resolveGovernanceVerdict(server_id, tool_name, isInternalServer);
  if (!verdict.governed) return "ungoverned";
  if (verdict.mapped && verdict.decision_class) {
    return CLASS_DEFAULT_AUTONOMY[verdict.decision_class] ?? "approval";
  }
  return "approval";
}

export type MoneyMoveCase = {
  kind: "money_move";
  name: string;
  incident?: "money_move_auto_fire";
  money_or_write: boolean;
  input: { server_id: string; tool_name: string };
  expect: { autonomy: CodeSideAutonomy };
};

const MONEY_MOVE: MoneyMoveCase[] = [
  {
    kind: "money_move",
    name: "stripe create_payment → APPROVAL (charge a card needs a human)",
    incident: "money_move_auto_fire",
    money_or_write: true,
    input: { server_id: "stripe", tool_name: "create_payment" },
    expect: { autonomy: "approval" },
  },
  {
    kind: "money_move",
    name: "stripe remit_to_tenant → APPROVAL (pay out money needs a human)",
    incident: "money_move_auto_fire",
    money_or_write: true,
    input: { server_id: "stripe", tool_name: "remit_to_tenant" },
    expect: { autonomy: "approval" },
  },
  {
    kind: "money_move",
    name: "stripe submit_dispute_evidence → APPROVAL (irreversible filing)",
    incident: "money_move_auto_fire",
    money_or_write: true,
    input: { server_id: "stripe", tool_name: "submit_dispute_evidence" },
    expect: { autonomy: "approval" },
  },
  {
    kind: "money_move",
    name: "stripe create_connected_account → APPROVAL (onboards a payout account)",
    incident: "money_move_auto_fire",
    money_or_write: true,
    input: { server_id: "stripe", tool_name: "create_connected_account" },
    expect: { autonomy: "approval" },
  },
  {
    kind: "money_move",
    name: "stripe refund_customer (UNMAPPED) → APPROVAL (fail-closed, new money tool)",
    incident: "money_move_auto_fire",
    money_or_write: true,
    input: { server_id: "stripe", tool_name: "refund_customer" },
    expect: { autonomy: "approval" },
  },
  {
    kind: "money_move",
    name: "email send → APPROVAL (outbound to a customer needs a human)",
    money_or_write: true,
    input: { server_id: "email", tool_name: "send" },
    expect: { autonomy: "approval" },
  },
  {
    kind: "money_move",
    name: "github open_pr → APPROVAL (code change needs a human by default)",
    money_or_write: true,
    input: { server_id: "github", tool_name: "open_pr" },
    expect: { autonomy: "approval" },
  },
  {
    kind: "money_move",
    name: "slack post_message → AUTO (teammate messaging, not a money move)",
    money_or_write: false,
    input: { server_id: "slack", tool_name: "post_message" },
    expect: { autonomy: "auto" },
  },
  {
    kind: "money_move",
    name: "stripe list_charges → UNGOVERNED (a declared READ never needs approval)",
    money_or_write: false,
    input: { server_id: "stripe", tool_name: "list_charges" },
    expect: { autonomy: "ungoverned" },
  },
];

export type EnvelopeCase = {
  kind: "envelope";
  name: string;
  incident?:
    | "meta_placeholder_double_render"
    | "blank_render_seam"
    | "machine_json_leak";
  input: {
    envelope: string;
    agentSlug: string;
    parsed: Record<string, unknown> | null;
    rawText: string;
  };
  expect: {
    contains?: string[];
    excludes?: string[];
    rescueKind?: "structured_questions" | "preceding_prose" | null;
    nonEmpty?: boolean;
  };
};

const ENVELOPE: EnvelopeCase[] = [
  {
    kind: "envelope",
    name: "good rendered_markdown → shown verbatim (the 99% path)",
    input: {
      envelope: "digest",
      agentSlug: "growth-lead",
      parsed: { rendered_markdown: "## Weekly bet\n- Ship the referral loop" },
      rawText: "<digest>{...}</digest>",
    },
    expect: { contains: ["Weekly bet", "referral loop"], rescueKind: null, nonEmpty: true },
  },
  {
    kind: "envelope",
    name: "meta-placeholder rendered_markdown → RESCUED to preceding prose (not double-rendered)",
    incident: "meta_placeholder_double_render",
    input: {
      envelope: "digest",
      agentSlug: "chief-of-staff",
      parsed: { rendered_markdown: "Asking 5 clarifying questions. No backlog emitted." },
      rawText:
        "Here is the substantive analysis the operator actually needs, more than fifty characters of real content before the envelope block.\n<digest>{...}</digest>",
    },
    expect: {
      contains: ["substantive analysis"],
      excludes: ["Asking 5 clarifying questions"],
      rescueKind: "preceding_prose",
      nonEmpty: true,
    },
  },
  {
    kind: "envelope",
    name: "missing render channel → non-empty placeholder, NEVER a blank bubble",
    incident: "blank_render_seam",
    input: {
      envelope: "digest",
      agentSlug: "operator",
      parsed: {},
      rawText: "<digest></digest>",
    },
    expect: { contains: ["run completed"], nonEmpty: true, rescueKind: null },
  },
  {
    kind: "envelope",
    name: "machine-JSON echoed into rendered_markdown → scrubbed before chat render",
    incident: "machine_json_leak",
    input: {
      envelope: "digest",
      agentSlug: "content-design",
      parsed: {
        rendered_markdown:
          'Here is my recommendation.\n\n```json\n{"recommendations":[{"id":1}]}\n```',
      },
      rawText: "<digest>{...}</digest>",
    },
    expect: {
      contains: ["recommendation"],
      excludes: ['"recommendations"', "```json"],
      rescueKind: null,
      nonEmpty: true,
    },
  },
  {
    kind: "envelope",
    name: "null parsed → falls back to trimmed raw text (never throws)",
    input: {
      envelope: "digest",
      agentSlug: "research",
      parsed: null,
      rawText: "  a plain prose reply  ",
    },
    expect: { contains: ["a plain prose reply"], nonEmpty: true },
  },
];

export type BehaviorGolden = MoneyMoveCase | EnvelopeCase;

export const BEHAVIOR_GOLDENS: BehaviorGolden[] = [...MONEY_MOVE, ...ENVELOPE];
