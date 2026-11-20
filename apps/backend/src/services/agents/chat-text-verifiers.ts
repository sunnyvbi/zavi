
import type { ToolCallTrace } from "@/services/tools/types";
import {
  verifyDocOnlyClaims,
  DOC_ONLY_CLAIM_AGENTS,
} from "./doc-only-claim-verifier";
import { CAP_VALIDATOR_AGENTS, verifyCapGrounding } from "./cap-grounding-verifier";
import {
  ROAS_SAMPLE_VALIDATOR_AGENTS,
  verifyRoasSampleGrounding,
} from "./roas-sample-grounding-verifier";
import { verifyCappedAggregate } from "./capped-aggregate-verifier";
import {
  FABRICATED_BLOCKER_VALIDATOR_AGENTS,
  verifyNoFabricatedBlocker,
} from "./fabricated-blocker-verifier";
import {
  UNVERIFIED_ABSENCE_VALIDATOR_AGENTS,
  verifyNoUnverifiedAbsence,
} from "./unverified-absence-verifier";
import {
  actionClaimGuardEnabled,
  verifyActionAndLiveReadClaims,
  toolBrokenClaimGuardEnabled,
  verifyToolBrokenClaim,
} from "./claim-grounding-verifier";

export type ChatTextVerifierId =
  | "cap_grounding"
  | "roas_sample_grounding"
  | "capped_aggregate"
  | "fabricated_blocker"
  | "unverified_absence"
  | "action_claim"
  | "tool_broken_claim"
  | "doc_only_claim";

export interface ChatTextVerifierTrigger {
  id: ChatTextVerifierId;
  source: string;
  code: string;
  meta: Record<string, unknown>;
}

export interface ChatTextVerifiersResult {
  text: string;
  metaPatch: Record<string, unknown>;
  triggered: ChatTextVerifierTrigger[];
}

interface Entry {
  id: ChatTextVerifierId;
  gate: (agentSlug: string) => boolean;
  run: (args: {
    text: string;
    toolCalls: readonly ToolCallTrace[] | undefined;
    dispatchedActions: readonly unknown[] | undefined;
    agentSlug: string;
    codeSearchAvailable: boolean | undefined;
  }) => {
    text?: string;
    trigger: Omit<ChatTextVerifierTrigger, "id">;
    metaPatch: Record<string, unknown>;
  } | null;
}

const ENTRIES: readonly Entry[] = [
  {
    id: "cap_grounding",
    gate: (slug) => CAP_VALIDATOR_AGENTS.has(slug),
    run: ({ text, toolCalls, agentSlug }) => {
      const r = verifyCapGrounding({ reply: text, toolCalls });
      if (!r.hedged) return null;
      return {
        metaPatch: {
          cap_grounding_fired: true,
          cap_grounding_amounts: r.flags.ungrounded_amounts,
        },
        trigger: {
          source: "agent.cap-grounding",
          code: "cap_grounding_hedged",
          meta: {
            agent_slug: agentSlug,
            ungrounded_amounts: r.flags.ungrounded_amounts,
            count: r.flags.ungrounded_amounts.length,
          },
        },
      };
    },
  },
  {
    id: "roas_sample_grounding",
    gate: (slug) => ROAS_SAMPLE_VALIDATOR_AGENTS.has(slug),
    run: ({ text, toolCalls, agentSlug }) => {
      const r = verifyRoasSampleGrounding({ reply: text, toolCalls });
      if (!r.hedged) return null;
      return {
        metaPatch: {
          roas_sample_grounding_fired: true,
          roas_sample_grounding_count: r.flags.ungrounded_sentences.length,
        },
        trigger: {
          source: "agent.roas-sample-grounding",
          code: "roas_sample_grounding_hedged",
          meta: {
            agent_slug: agentSlug,
            count: r.flags.ungrounded_sentences.length,
          },
        },
      };
    },
  },
  {
    id: "capped_aggregate",
    gate: () => true,
    run: ({ text, toolCalls, agentSlug }) => {
      const r = verifyCappedAggregate({ reply: text, toolCalls });
      if (!r.hedged) return null;
      return {
        metaPatch: {
          capped_aggregate_fired: true,
          capped_aggregate_count: r.flags.ungrounded_sentences.length,
        },
        trigger: {
          source: "agent.capped-aggregate",
          code: "capped_aggregate_hedged",
          meta: {
            agent_slug: agentSlug,
            count: r.flags.ungrounded_sentences.length,
            capped_tools: r.flags.capped_tools,
          },
        },
      };
    },
  },
  {
    id: "fabricated_blocker",
    gate: (slug) => FABRICATED_BLOCKER_VALIDATOR_AGENTS.has(slug),
    run: ({ text, toolCalls, agentSlug }) => {
      const r = verifyNoFabricatedBlocker({ reply: text, toolCalls });
      if (!r.hedged) return null;
      return {
        metaPatch: { fabricated_blocker_seatbelt_fired: true },
        trigger: {
          source: "agent.fabricated-blocker",
          code: "fabricated_blocker_hedged",
          meta: { agent_slug: agentSlug },
        },
      };
    },
  },
  {
    id: "unverified_absence",
    gate: (slug) => UNVERIFIED_ABSENCE_VALIDATOR_AGENTS.has(slug),
    run: ({ text, toolCalls, agentSlug, codeSearchAvailable }) => {
      const r = verifyNoUnverifiedAbsence({ reply: text, toolCalls, codeSearchAvailable });
      if (!r.hedged) return null;
      return {
        metaPatch: { unverified_absence_fired: true },
        trigger: {
          source: "agent.unverified-absence",
          code: "unverified_absence_hedged",
          meta: {
            agent_slug: agentSlug,
            count: r.flags.matched_phrases.length,
          },
        },
      };
    },
  },
  {
    id: "action_claim",
    gate: () => actionClaimGuardEnabled(),
    run: ({ text, toolCalls, dispatchedActions, agentSlug }) => {
      const r = verifyActionAndLiveReadClaims({
        reply: text,
        toolCalls,
        dispatchedActions,
      });
      if (!r.flagged) return null;
      return {
        metaPatch: {
          action_claim_guard_fired: true,
          action_claim_flagged: r.flags.action_claim,
        },
        trigger: {
          source: "agent.action-claim-grounding",
          code: "action_claim_flagged",
          meta: { agent_slug: agentSlug, action: r.flags.action_claim },
        },
      };
    },
  },
  {
    id: "tool_broken_claim",
    gate: () => toolBrokenClaimGuardEnabled(),
    run: ({ text, toolCalls, agentSlug }) => {
      const r = verifyToolBrokenClaim({ reply: text, toolCalls });
      if (!r.flagged) return null;
      return {
        metaPatch: { tool_broken_claim_guard_fired: true },
        trigger: {
          source: "agent.tool-broken-claim-grounding",
          code: "tool_broken_claim_flagged",
          meta: {
            agent_slug: agentSlug,
            matched_patterns: r.flags.matched_patterns,
          },
        },
      };
    },
  },
  {
    id: "doc_only_claim",
    gate: (slug) => DOC_ONLY_CLAIM_AGENTS.has(slug),
    run: ({ text, toolCalls, agentSlug }) => {
      const r = verifyDocOnlyClaims({ agentSlug, text, toolCalls });
      if (!r.changed) return null;
      return {
        text: r.text,
        metaPatch: {
          doc_only_claim_fired: true,
          doc_only_claim_reshaped: r.reshaped,
        },
        trigger: {
          source: "agent.doc-only-claim",
          code: "doc_only_claims_reshaped",
          meta: { agent_slug: agentSlug, reshaped: r.reshaped },
        },
      };
    },
  },
];

export function applyChatTextVerifiers(args: {
  text: string;
  toolCalls?: readonly ToolCallTrace[];
  dispatchedActions?: readonly unknown[];
  agentSlug: string;
  codeSearchAvailable?: boolean;
}): ChatTextVerifiersResult {
  let text = typeof args.text === "string" ? args.text : "";
  const metaPatch: Record<string, unknown> = {};
  const triggered: ChatTextVerifierTrigger[] = [];

  if (text.length === 0) return { text, metaPatch, triggered };

  for (const entry of ENTRIES) {
    try {
      if (!entry.gate(args.agentSlug)) continue;
      const out = entry.run({
        text,
        toolCalls: args.toolCalls,
        dispatchedActions: args.dispatchedActions,
        agentSlug: args.agentSlug,
        codeSearchAvailable: args.codeSearchAvailable,
      });
      if (!out) continue;
      if (typeof out.text === "string") text = out.text;
      Object.assign(metaPatch, out.metaPatch);
      triggered.push({ id: entry.id, ...out.trigger });
    } catch (e) {
      console.warn(
        `[chat-text-verifiers] ${entry.id} threw (reply persists unhedged for this check): ${
          (e as Error).message
        }`,
      );
    }
  }

  return { text, metaPatch, triggered };
}

export const CHAT_TEXT_VERIFIER_IDS: readonly ChatTextVerifierId[] = ENTRIES.map(
  (e) => e.id,
);
