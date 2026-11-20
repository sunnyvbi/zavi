
export const GROWTH_PROBLEMS = ["traffic", "conversion", "activation", "retention", "offer", "tracking", "channel", "other"] as const;
export type ListedProblem = (typeof GROWTH_PROBLEMS)[number];
export type GrowthProblem = ListedProblem | "unspecified";

export function normalizeProblem(v: unknown): GrowthProblem {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return (GROWTH_PROBLEMS as readonly string[]).includes(s) ? (s as GrowthProblem) : "unspecified";
}
