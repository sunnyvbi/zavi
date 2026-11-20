
import type { ToolCallTrace } from "@/services/tools/types";
import { verifyCapGrounding } from "./cap-grounding-verifier";
import { isMoneyPathSlug } from "./infra-retry";

export type ProvenanceDisposition = "pass" | "route_to_review" | "block";

export interface ProvenanceGateResult {
  disposition: ProvenanceDisposition;
  ungrounded_amounts: string[];
  reason: "ok" | "provenance_missing";
  body: unknown;
}

const BANNER_TARGET_FIELDS = [
  "summary",
  "rationale",
  "rendered_markdown",
  "body_markdown",
  "text",
  "message",
] as const;

function buildReviewBanner(amounts: string[]): string {
  const list = amounts.map((a) => `$${a}`).join(", ");
  return [
    "> 🛑 **Human review required — unverified cap/policy** — this decision asserts a spending cap or policy (" +
      list +
      ") that no tool result from this run supports.",
    "> It has NOT been auto-approved. Confirm the real limit before approving this action.",
    "",
    "",
  ].join("\n");
}

function collectBodyText(body: unknown): string {
  const out: string[] = [];
  let budget = 200_000;
  const walk = (v: unknown, depth: number): void => {
    if (budget <= 0 || depth > 8) return;
    if (typeof v === "string") {
      const s = v.slice(0, budget);
      out.push(s);
      budget -= s.length;
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) walk(item, depth + 1);
      return;
    }
    if (v && typeof v === "object") {
      for (const val of Object.values(v as Record<string, unknown>)) {
        walk(val, depth + 1);
      }
    }
  };
  walk(body, 0);
  return out.join("\n");
}

function routeBodyForReview(
  body: unknown,
  banner: string,
  amounts: string[],
): unknown {
  const base: Record<string, unknown> =
    body && typeof body === "object" && !Array.isArray(body)
      ? { ...(body as Record<string, unknown>) }
      : { value: body };

  let bannerPlaced = false;
  for (const field of BANNER_TARGET_FIELDS) {
    if (typeof base[field] === "string") {
      base[field] = banner + (base[field] as string);
      bannerPlaced = true;
      break;
    }
  }
  if (!bannerPlaced) {
    base.provenance_review_banner = banner;
  }

  const meta =
    base.metadata && typeof base.metadata === "object" && !Array.isArray(base.metadata)
      ? { ...(base.metadata as Record<string, unknown>) }
      : {};
  base.metadata = {
    ...meta,
    provenance_review: {
      required: true,
      reason: "provenance_missing",
      ungrounded_amounts: amounts,
    },
  };
  return base;
}

export function shouldHardBlock(_args: {
  agentSlug: string;
  ungroundedAmounts: string[];
}): boolean {
  return false;
}

export function decideProvenanceEmit(args: {
  enabled: boolean;
  agentSlug: string;
  body: unknown;
  toolCalls?: readonly ToolCallTrace[];
}): ProvenanceGateResult {
  const pass = (): ProvenanceGateResult => ({
    disposition: "pass",
    ungrounded_amounts: [],
    reason: "ok",
    body: args.body,
  });

  if (!args.enabled) return pass();

  if (!isMoneyPathSlug(args.agentSlug)) return pass();

  const toolCalls = args.toolCalls ?? [];
  const bodyText = collectBodyText(args.body);
  if (bodyText.length === 0) return pass();

  const cap = verifyCapGrounding({ reply: bodyText, toolCalls });
  if (!cap.hedged) return pass();

  const ungrounded = cap.flags.ungrounded_amounts;

  if (shouldHardBlock({ agentSlug: args.agentSlug, ungroundedAmounts: ungrounded })) {
    return {
      disposition: "block",
      ungrounded_amounts: ungrounded,
      reason: "provenance_missing",
      body: args.body,
    };
  }

  return {
    disposition: "route_to_review",
    ungrounded_amounts: ungrounded,
    reason: "provenance_missing",
    body: routeBodyForReview(args.body, buildReviewBanner(ungrounded), ungrounded),
  };
}
