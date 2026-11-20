
export type GrowthFunction =
  | "acquisition"
  | "activation"
  | "retention"
  | "revenue"
  | "referral"
  | "ops"
  | "support";

export const GROWTH_FUNCTIONS: readonly GrowthFunction[] = [
  "acquisition",
  "activation",
  "retention",
  "revenue",
  "referral",
  "ops",
  "support",
] as const;

export const FUNCTION_AGENTS: Record<GrowthFunction, readonly string[]> = {
  acquisition: ["performance-marketer", "growth-lead"],
  activation: ["pm", "operator"],
  retention: ["pm", "support-lead", "chief-of-staff"],
  revenue: ["performance-marketer", "growth-lead"],
  referral: ["growth-lead"],
  ops: ["operator", "engineer", "qa", "browser-operator"],
  support: ["support-lead", "dispute-response"],
};

export type AgentHandlingState = "handling" | "idle" | "hidden" | "not_present";

export type FunctionCoverage = {
  fn: GrowthFunction;
  agents: Array<{ slug: string; state: AgentHandlingState }>;
  agentHandling: number;
  applicableAgents: number;
  adminCovered: number;
  notApplicable: boolean;
  autonomyPct: number | null;
  uncovered: boolean;
};

export function buildCoverageMap(
  handlingBySlug: Map<string, { present: boolean; hidden: boolean; handling: boolean }>,
  adminCoverByFn: Partial<Record<GrowthFunction, number>> = {},
): FunctionCoverage[] {
  return GROWTH_FUNCTIONS.map((fn) => {
    const mapped = FUNCTION_AGENTS[fn];
    const agents = mapped.map((slug) => {
      const h = handlingBySlug.get(slug);
      let state: AgentHandlingState;
      if (!h || !h.present) state = "not_present";
      else if (h.hidden) state = "hidden";
      else if (h.handling) state = "handling";
      else state = "idle";
      return { slug, state };
    });
    const applicableAgents = agents.filter((a) => a.state !== "not_present" && a.state !== "hidden").length;
    const agentHandling = agents.filter((a) => a.state === "handling").length;
    const adminCovered = adminCoverByFn[fn] ?? 0;
    const notApplicable = applicableAgents === 0;
    const autonomyPct = notApplicable
      ? null
      : Math.round((agentHandling / applicableAgents) * 100);
    const uncovered = !notApplicable && agentHandling === 0 && adminCovered === 0;
    return {
      fn,
      agents,
      agentHandling,
      applicableAgents,
      adminCovered,
      notApplicable,
      autonomyPct,
      uncovered,
    };
  });
}
