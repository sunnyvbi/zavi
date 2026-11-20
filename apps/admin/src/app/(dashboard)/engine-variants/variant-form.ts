
export type Config = {
  model?: string;
  effort?: string;
  thinking?: { type: "disabled" | "adaptive" } | { type: "enabled"; budget_tokens: number };
  max_turns?: number;
  isolate_settings?: boolean;
  fallback_model?: string;
  max_budget_usd?: number;
  tools?: { always_load?: string[] };
  prompt?: { agent_file?: string; drop_core?: string[]; skills?: string[] };
};

const FORM_OWNED = ["model", "effort", "thinking", "max_turns", "isolate_settings", "prompt"] as const;
const FORM_OWNED_PROMPT = ["agent_file", "drop_core"] as const;

export const EMPTY = {
  slug: "",
  label: "",
  note: "",
  model: "",
  effort: "",
  thinking: "",
  budget: "2048",
  maxTurns: "",
  isolate: false,
  agentFile: "",
  dropCore: [] as string[],
  carried: {} as Config,
};
export type Form = typeof EMPTY;

export function toConfig(f: Form): Config {
  const c: Config = { ...f.carried };
  if (f.model.trim()) c.model = f.model.trim();
  if (f.effort) c.effort = f.effort;
  if (f.thinking === "enabled") c.thinking = { type: "enabled", budget_tokens: Number(f.budget) };
  else if (f.thinking === "disabled" || f.thinking === "adaptive") c.thinking = { type: f.thinking };
  if (f.maxTurns) c.max_turns = Number(f.maxTurns);
  if (f.isolate) c.isolate_settings = true;
  const prompt: NonNullable<Config["prompt"]> = { ...(f.carried.prompt ?? {}) };
  if (f.agentFile.trim()) prompt.agent_file = f.agentFile.trim();
  if (f.dropCore.length) prompt.drop_core = f.dropCore;
  if (Object.keys(prompt).length) c.prompt = prompt;
  return c;
}

export function toForm(v: { slug: string; label: string; note: string | null; config: Config }): Form {
  const t = v.config.thinking;
  const carried: Config = {};
  for (const [k, val] of Object.entries(v.config)) {
    if (!(FORM_OWNED as readonly string[]).includes(k)) (carried as Record<string, unknown>)[k] = val;
  }
  const carriedPrompt = Object.fromEntries(
    Object.entries(v.config.prompt ?? {}).filter(
      ([k]) => !(FORM_OWNED_PROMPT as readonly string[]).includes(k),
    ),
  );
  if (Object.keys(carriedPrompt).length) carried.prompt = carriedPrompt as Config["prompt"];
  return {
    slug: v.slug,
    label: v.label,
    note: v.note ?? "",
    model: v.config.model ?? "",
    effort: v.config.effort ?? "",
    thinking: t?.type ?? "",
    budget: t?.type === "enabled" ? String(t.budget_tokens) : "2048",
    maxTurns: v.config.max_turns ? String(v.config.max_turns) : "",
    isolate: v.config.isolate_settings === true,
    agentFile: v.config.prompt?.agent_file ?? "",
    dropCore: v.config.prompt?.drop_core ?? [],
    carried,
  };
}

export function carriedSummary(f: Form): string {
  const parts: string[] = [];
  if (f.carried.prompt?.skills?.length) parts.push(`prompt.skills: ${f.carried.prompt.skills.join(", ")}`);
  if (f.carried.tools?.always_load?.length) parts.push(`tools.always_load: ${f.carried.tools.always_load.join(", ")}`);
  if (f.carried.fallback_model) parts.push(`fallback_model: ${f.carried.fallback_model}`);
  if (f.carried.max_budget_usd) parts.push(`max_budget_usd: ${f.carried.max_budget_usd}`);
  return parts.join(" · ");
}
