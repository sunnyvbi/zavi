
export const RUN_PHASES = {
  loading_tools: "Loading your connected tools",
  starting_model: "Starting up",
  first_turn: "Thinking it through",
} as const;

export type RunPhase = keyof typeof RUN_PHASES;

export const RUN_PHASE_VERB: Record<RunPhase, string> = {
  loading_tools: "loading your tools",
  starting_model: "getting started",
  first_turn: "thinking it through",
};

const BY_TEXT = new Map<string, RunPhase>(
  (Object.keys(RUN_PHASES) as RunPhase[]).map((k) => [RUN_PHASES[k], k]),
);

export function runPhaseOf(text: unknown): RunPhase | null {
  return typeof text === "string" ? (BY_TEXT.get(text.trim()) ?? null) : null;
}
