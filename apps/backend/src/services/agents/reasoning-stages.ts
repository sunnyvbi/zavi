
export type ReasoningStage = "triangulate" | "ground" | "critic";

export type PipelineSeam =
  | "generation"
  | "post-text"
  | "pre-emit-decision"
  | "per-agent-emit";

export interface ReasoningStageEntry {
  stage: ReasoningStage;
  mechanism: string;
  seam: PipelineSeam;
  module: string;
  trigger: string;
  status: "on-by-default" | "flag-gated" | "shadow";
}

export const REASONING_STAGES: readonly ReasoningStageEntry[] = [
  {
    stage: "triangulate",
    mechanism: "best-of-n",
    seam: "generation",
    module: "services/agents/best-of-n.ts",
    trigger: "resolveBestOfNPolicy enabled + N>1 (fails closed → disabled)",
    status: "flag-gated",
  },
  {
    stage: "ground",
    mechanism: "claim-grounding-verifier (absence/action)",
    seam: "post-text",
    module: "services/agents/claim-grounding-verifier.ts",
    trigger: "post-text on claim-bearing agents",
    status: "on-by-default",
  },
  {
    stage: "ground",
    mechanism: "cap-grounding-verifier",
    seam: "post-text",
    module: "services/agents/cap-grounding-verifier.ts",
    trigger: "CAP_VALIDATOR_AGENTS + dollar-cap claim",
    status: "on-by-default",
  },
  {
    stage: "ground",
    mechanism: "roas-sample-grounding-verifier",
    seam: "post-text",
    module: "services/agents/roas-sample-grounding-verifier.ts",
    trigger: "performance-marketer ROAS sentences",
    status: "on-by-default",
  },
  {
    stage: "ground",
    mechanism: "autonomous-grounding",
    seam: "post-text",
    module: "services/agents/autonomous-grounding.ts",
    trigger: "autonomous-run grounding pass",
    status: "on-by-default",
  },
  {
    stage: "ground",
    mechanism: "entity-traction-grounding-verifier",
    seam: "post-text",
    module: "services/agents/entity-traction-grounding-verifier.ts",
    trigger: "entity/traction claims",
    status: "flag-gated",
  },
  {
    stage: "ground",
    mechanism: "negative-existence-grounding-verifier",
    seam: "post-text",
    module: "services/agents/negative-existence-grounding-verifier.ts",
    trigger: "negative-existence claims",
    status: "on-by-default",
  },
  {
    stage: "ground",
    mechanism: "reasoning-harness prose shadow",
    seam: "post-text",
    module: "services/agents/reasoning-harness.ts",
    trigger: "PROSE_SHADOW_AGENTS final prose (P0.3, logging-only)",
    status: "shadow",
  },
  {
    stage: "critic",
    mechanism: "advisor critic",
    seam: "per-agent-emit",
    module: "agents/advisor/critic.ts",
    trigger: "advisor envelope + per-tenant x-family flag (fail-closed)",
    status: "flag-gated",
  },
  {
    stage: "critic",
    mechanism: "pm critic",
    seam: "per-agent-emit",
    module: "agents/pm/critic.ts",
    trigger: "pm backlog + per-tenant x-family flag (fail-closed)",
    status: "flag-gated",
  },
  {
    stage: "critic",
    mechanism: "research claim-grounding",
    seam: "per-agent-emit",
    module: "agents/research/claim-grounding.ts",
    trigger: "research report claims (default-on kill-switch)",
    status: "on-by-default",
  },
];

export function stagesFor(stage: ReasoningStage): ReasoningStageEntry[] {
  return REASONING_STAGES.filter((s) => s.stage === stage);
}

export function stagesAtSeam(seam: PipelineSeam): ReasoningStageEntry[] {
  return REASONING_STAGES.filter((s) => s.seam === seam);
}

export function describeReasoningStages(): string {
  const byStage: Record<ReasoningStage, string[]> = {
    triangulate: [],
    ground: [],
    critic: [],
  };
  for (const s of REASONING_STAGES) {
    byStage[s.stage].push(`${s.mechanism} @${s.seam} (${s.status})`);
  }
  return (["triangulate", "ground", "critic"] as ReasoningStage[])
    .map((st) => `${st}: ${byStage[st].join("; ") || "(none)"}`)
    .join("\n");
}
