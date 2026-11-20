
import type { ToolCallTrace } from "@/services/tools/types";
import { verifyClaimGrounding } from "./claim-grounding-verifier";
import {
  OPERATOR_DB_DOMAIN_AGENTS,
  PAYMENT_DOMAIN_AGENTS,
  TRUNCATED_SCOPE_DOMAIN_AGENTS,
} from "./guard-domains";
import {
  runGroundingChecks,
  hasHardGroundingFlag,
  isPaymentMechanicsSentence,
  type GroundingResult,
  type ToolCallLite,
} from "./eval/grounding-checks";
import { removeClaimSentences } from "./side-effect-claim-reconciler";
import {
  verifyStatusRealityGrounding,
  type StatusGroundingTier,
} from "./ticket-status-grounding-verifier";
import type { ShipEvidence } from "./repo-ship-probe";

export type AutonomousGroundingResult = {
  annotated: boolean;
  text: string;
  claim_grounding_hedged: boolean;
  claim_grounding_flags: ReturnType<typeof verifyClaimGrounding>["flags"];
  deterministic_hard_flag: boolean;
  deterministic_patterns: string[];
  status_reality_tier: StatusGroundingTier;
  linked_record_unread: boolean;
};

export const PAYMENT_RECORD_UNREAD_PHRASE =
  "I haven't checked this payment's record yet, so I can't say what happened to it. Want me to look it up?";

export function replaceUnreadPaymentClaims(text: string): string {
  const r = removeClaimSentences(text, isPaymentMechanicsSentence);
  if (r.removed === 0 || r.text.length === 0) return PAYMENT_RECORD_UNREAD_PHRASE;
  return `${r.text}\n\n${PAYMENT_RECORD_UNREAD_PHRASE}`;
}

function toEvidence(toolCalls: readonly ToolCallTrace[]): ToolCallLite[] {
  return toolCalls.map((t) => ({
    name: t.name,
    status: t.status,
    input: t.input_preview,
    output: t.output_preview,
    returned_ids: t.returned_ids,
  }));
}

const HARD_FLAG_BANNER_MARKER = "**Unverified figure**";
const GENERATED_HARD_FLAG_LINE = /^>\s*⚠️\s*\*\*Unverified figure\*\*\s*\(not from your live data\)/;

export function namedQuantToken(result: GroundingResult): string | null {
  const quant = result.flags.find((f) => f.pattern === "unsupported_quant_claim");
  return quant?.detail.match(/asserts\s+"([^"]+)"/)?.[1] ?? null;
}

export function buildHardFlagBanner(result: GroundingResult): string {
  const scope = result.flags.find(
    (f) => f.pattern === "truncated_scope_overclaim" && f.severity === "hard",
  );
  if (scope && !result.flags.some((f) => f.pattern === "unsupported_quant_claim")) {
    return `> ⚠️ **Unverified scope** — this describes rows the data source never returned. Ask for the full list before acting on it.`;
  }
  const token = namedQuantToken(result);
  return token
    ? `> ⚠️ ${HARD_FLAG_BANNER_MARKER} (not from your live data): ${token}.`
    : `> ⚠️ ${HARD_FLAG_BANNER_MARKER} (not from your live data).`;
}

export function stripAutonomousGroundingBanner(text: string): string {
  if (typeof text !== "string" || !text.includes(HARD_FLAG_BANNER_MARKER)) return text;
  return text
    .split("\n")
    .filter((line) => !GENERATED_HARD_FLAG_LINE.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

export function hasAutonomousHardFlagBanner(text: string): boolean {
  return typeof text === "string" && text.includes(HARD_FLAG_BANNER_MARKER);
}

export function extractAutonomousGroundingFigure(text: string): string | null {
  if (typeof text !== "string") return null;
  const line = text.split("\n").find((l) => GENERATED_HARD_FLAG_LINE.test(l));
  return line?.match(/\(not from your live data\):\s*(.+?)\.?\s*$/)?.[1] ?? null;
}

export function applyAutonomousGrounding(args: {
  text: string;
  toolCalls?: readonly ToolCallTrace[];
  inboundContext?: string;
  agentSlug?: string | null;
  statusEvidence?: ShipEvidence | null;
}): AutonomousGroundingResult {
  const original = typeof args.text === "string" ? args.text : "";
  const toolCalls = args.toolCalls ?? [];

  const verified = verifyClaimGrounding({ reply: original, toolCalls });

  const slug = args.agentSlug ?? "";
  const deterministic = runGroundingChecks({
    evidence: toEvidence(toolCalls),
    agent_output: original,
    input: args.inboundContext ?? "",
    agentSlug: slug,
    checkUnsupportedQuant: OPERATOR_DB_DOMAIN_AGENTS.has(slug),
    checkTruncatedScope: TRUNCATED_SCOPE_DOMAIN_AGENTS.has(slug),
    checkLinkedRecord: PAYMENT_DOMAIN_AGENTS.has(slug),
  });
  const hardFlag = hasHardGroundingFlag(deterministic);

  let text = verified.text;
  if (hardFlag) {
    text = `${text}\n\n${buildHardFlagBanner(deterministic)}`;
  }

  const status = verifyStatusRealityGrounding(original, args.statusEvidence ?? null);
  if (status.tier !== "NOOP" && status.banner) {
    text = `> ${status.banner}\n\n${text}`;
  }

  return {
    annotated: verified.hedged || hardFlag || status.tier !== "NOOP",
    text,
    claim_grounding_hedged: verified.hedged,
    claim_grounding_flags: verified.flags,
    deterministic_hard_flag: hardFlag,
    deterministic_patterns: deterministic.flags.map((f) => f.pattern),
    status_reality_tier: status.tier,
    linked_record_unread: deterministic.flags.some(
      (f) => f.pattern === "linked_record_status_unread" && f.severity === "hard",
    ),
  };
}
