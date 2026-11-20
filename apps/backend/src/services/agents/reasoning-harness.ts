
import { verifyClaimGrounding } from "@/services/agents/claim-grounding-verifier";
import { logReview } from "@/services/logging/log-review";
import type { ToolCallTrace } from "@/services/tools/types";

export const PROSE_SHADOW_AGENTS: ReadonlySet<string> = new Set<string>([
  "research",
  "growth-lead",
  "pm",
  "advisor",
  "content-design",
]);

export type HarnessSurface = "prose";

export interface RunPreEmitHarnessArgs {
  tenant_id: string;
  agent_slug: string;
  run_id: string;
  surface: HarnessSurface;
  body: unknown;
  evidence?: readonly ToolCallTrace[] | unknown;
  opts?: HarnessOpts;
}

export interface HarnessOpts {
  ground?: boolean;
}

export interface PreEmitHarnessResult {
  body: unknown;
  stages_run: string[];
}

function runProseGroundingShadow(args: RunPreEmitHarnessArgs): void {
  if (!PROSE_SHADOW_AGENTS.has(args.agent_slug)) return;
  const text = typeof args.body === "string" ? args.body : "";
  if (!text) return;
  const toolCalls = Array.isArray(args.evidence)
    ? (args.evidence as readonly ToolCallTrace[])
    : [];
  const res = verifyClaimGrounding({ reply: text, toolCalls });
  if (!res.hedged) return;
  logReview({
    feature: "reasoning_harness",
    event: "prose_shadow",
    outcome: "flagged",
    run_id: args.run_id,
    tenant_id: args.tenant_id,
    meta: {
      agent_slug: args.agent_slug,
      has_absence_claim: res.flags.has_absence_claim ? 1 : 0,
      memory_used: res.flags.memory_used ? 1 : 0,
      truncated_evidence: res.flags.truncated_evidence ? 1 : 0,
    },
  });
}

export async function runPreEmitHarness(
  args: RunPreEmitHarnessArgs,
): Promise<PreEmitHarnessResult> {
  const original = args.body;
  const stages_run: string[] = [];
  try {
    if (args.opts?.ground ?? true) {
      runProseGroundingShadow(args);
      stages_run.push("ground");
    }
  } catch {
  }
  return { body: original, stages_run };
}
