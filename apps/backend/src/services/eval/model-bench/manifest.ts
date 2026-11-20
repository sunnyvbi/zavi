
export type ModelFamily =
  | "anthropic"
  | "openai"
  | "google"
  | "qwen"
  | "deepseek"
  | "moonshot"
  | "zhipu"
  | "mistral"
  | "meta"
  | "xai";

export const AGENT_DECLARED = "agent-declared";

export function anthropicToOpenRouterSlug(modelId: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(modelId.trim());
  if (!m) throw new Error(`cannot map "${modelId}" to an OpenRouter Anthropic slug`);
  const [, name, major, minor] = m;
  return `anthropic/claude-${name}-${minor !== undefined ? `${major}.${minor}` : major}`;
}

export const FLEET_CLAUDE_MODELS: readonly string[] = [
  "claude-sonnet-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-opus-5",
  "claude-opus-5-5",
  "claude-sonnet-5",
  "claude-sonnet-5-5",
  "claude-haiku-4-5-20251001",
];

export function probeModelIds(e: { model_id: string }): string[] {
  return e.model_id === AGENT_DECLARED ? FLEET_CLAUDE_MODELS.map(anthropicToOpenRouterSlug) : [e.model_id];
}

export function resolveSharedLoopModelId(envModel: string | undefined, effectiveModel: string): string {
  if (envModel === AGENT_DECLARED) return anthropicToOpenRouterSlug(effectiveModel);
  return envModel || "";
}

export type BenchRoute =
  | "shared_loop"
  | "claude_sdk";

export type ManifestEntry = {
  key: string;
  route: BenchRoute;
  model_id: string;
  upstream: string | null;
  family: ModelFamily;
  lineage: string;
  retention: string;
  judge_eligible: boolean;
};

const ENTRIES: ManifestEntry[] = [
  {
    key: "claude-sdk",
    route: "claude_sdk",
    model_id: AGENT_DECLARED,
    upstream: null,
    family: "anthropic",
    lineage: "Anthropic Claude via the Claude Agent SDK prod loop; model = each agent.md declared Claude id",
    retention: "Anthropic API: 30-day retention, no training on API data",
    judge_eligible: false,
  },
  {
    key: "claude-shared",
    route: "shared_loop",
    model_id: AGENT_DECLARED,
    upstream: "Anthropic",
    family: "anthropic",
    lineage: "Anthropic Claude (each agent's declared model) via OpenRouter -> Anthropic",
    retention: "Anthropic API: 30-day retention, no training on API data",
    judge_eligible: false,
  },
  {
    key: "gpt-5.5",
    route: "shared_loop",
    model_id: "openai/gpt-5.5",
    upstream: "OpenAI",
    family: "openai",
    lineage: "OpenAI GPT-5.5 via OpenRouter -> OpenAI",
    retention: "OpenAI API: 30-day abuse-monitoring retention",
    judge_eligible: true,
  },
  {
    key: "gpt-6-sol",
    route: "shared_loop",
    model_id: "openai/gpt-6-sol",
    upstream: "OpenAI",
    family: "openai",
    lineage: "OpenAI GPT-6 Sol via OpenRouter -> OpenAI",
    retention: "OpenAI API: 30-day abuse-monitoring retention",
    judge_eligible: false,
  },
  {
    key: "gpt-5.6-luna",
    route: "shared_loop",
    model_id: "openai/gpt-5.6-luna",
    upstream: "OpenAI",
    family: "openai",
    lineage: "OpenAI GPT-5.6 Luna via OpenRouter -> OpenAI",
    retention: "OpenAI API: 30-day abuse-monitoring retention",
    judge_eligible: false,
  },
  {
    key: "gemini-pro",
    route: "shared_loop",
    model_id: "google/gemini-3.1-pro-preview",
    upstream: "Google",
    family: "google",
    lineage: "Google Gemini 3.1 Pro (preview) via OpenRouter -> Google",
    retention: "Google API: no training on paid-tier data; transient caching",
    judge_eligible: true,
  },
  {
    key: "mistral",
    route: "shared_loop",
    model_id: "mistralai/mistral-medium-3-5",
    upstream: "Mistral",
    family: "mistral",
    lineage: "Mistral Medium 3.5 via OpenRouter -> Mistral",
    retention: "Mistral API: 30-day retention",
    judge_eligible: true,
  },
  {
    key: "deepseek",
    route: "shared_loop",
    model_id: "deepseek/deepseek-v4-pro",
    upstream: "DigitalOcean",
    family: "deepseek",
    lineage: "DeepSeek V4 Pro (open weights) via OpenRouter -> DigitalOcean",
    retention: "DigitalOcean inference: per provider terms (US host)",
    judge_eligible: true,
  },
  {
    key: "qwen",
    route: "shared_loop",
    model_id: "qwen/qwen3.8-27b",
    upstream: "Darkbloom",
    family: "qwen",
    lineage: "Alibaba Qwen3.8 27B (open weights) via OpenRouter -> Darkbloom",
    retention: "Darkbloom: per provider terms",
    judge_eligible: false,
  },
  {
    key: "kimi",
    route: "shared_loop",
    model_id: "moonshotai/kimi-k3",
    upstream: "Wafer",
    family: "moonshot",
    lineage: "Moonshot Kimi K3 (open weights) via OpenRouter -> Wafer",
    retention: "Wafer: per provider terms",
    judge_eligible: false,
  },
  {
    key: "glm",
    route: "shared_loop",
    model_id: "z-ai/glm-5.3",
    upstream: "DeepInfra",
    family: "zhipu",
    lineage: "Zhipu GLM 5.3 (open weights) via OpenRouter -> DeepInfra",
    retention: "DeepInfra: zero retention by default",
    judge_eligible: false,
  },
];

export const MODEL_MANIFEST: ReadonlyMap<string, ManifestEntry> = new Map(
  ENTRIES.map((e) => [e.key, Object.freeze({ ...e })]),
);

export const CLAUDE_SHARED_LOOP_KEY = "claude-shared";
export const CLAUDE_SDK_KEY = "claude-sdk";

export function resolveModel(key: string): ManifestEntry {
  const e = MODEL_MANIFEST.get(key);
  if (!e) {
    throw new Error(
      `model "${key}" is not in the bench manifest (unknown lineage is refused). ` +
        `Known: ${[...MODEL_MANIFEST.keys()].join(", ")}`,
    );
  }
  if (e.route === "shared_loop" && !e.upstream) {
    throw new Error(`model "${key}" has no pinned upstream; refusing an unpinned route.`);
  }
  return e;
}

export type JudgePick =
  | { status: "ok"; judges: [ManifestEntry, ManifestEntry] }
  | { status: "judge_unavailable"; reason: string };

export function pickJudges(
  comparisonFamilies: ReadonlyArray<ModelFamily>,
  manifest: Iterable<ManifestEntry> = MODEL_MANIFEST.values(),
): JudgePick {
  const excluded = new Set(comparisonFamilies);
  const byFamily = new Map<ModelFamily, ManifestEntry>();
  for (const e of manifest) {
    if (!e.judge_eligible || e.route !== "shared_loop" || !e.upstream) continue;
    if (excluded.has(e.family)) continue;
    if (!byFamily.has(e.family)) byFamily.set(e.family, e);
  }
  const picks = [...byFamily.values()];
  if (picks.length < 2) {
    return {
      status: "judge_unavailable",
      reason: `only ${picks.length} judge-eligible famil${picks.length === 1 ? "y" : "ies"} outside {${[...excluded].join(", ")}}`,
    };
  }
  return { status: "ok", judges: [picks[0], picks[1]] };
}
