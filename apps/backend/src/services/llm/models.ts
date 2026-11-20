
export type Provider =
  | "anthropic"
  | "openai"
  | "bedrock"
  | "fireworks"
  | "codex"
  | "langchain"
  | "openrouter";

export const MODELS = {
  anthropic: {
    opus: "claude-opus-5-5",
    sonnet: "claude-sonnet-5-5",
    haiku: "claude-haiku-4-5-20251001",
  },
  openai: {
    flagship: "gpt-5.5",
  },
  bedrock: {
    qwen3Next80b: "qwen.qwen3-next-80b-a3b-instruct",

    judgeMistralLarge3: "mistral.mistral-large-3-675b-instruct",
    judgeDeepseekV32: "deepseek.v3.2",
    judgeDeepseekV31: "deepseek.v3.1",

    glm5: "zai.glm-5",
  },
  fireworks: {
    glm52: "accounts/fireworks/models/glm-5p2",

    kimiK3: "accounts/fireworks/models/kimi-k3",
  },
} as const;

export const DEFAULT_AGENT_MODEL = MODELS.anthropic.sonnet;

export type Role =
  | "synthMarkdown"
  | "pm_critic"
  | "pm_revise"
  | "triage"
  | "repo_picker"
  | "default"
  | "fast";

export const DEFAULT_PROVIDER: Provider = "anthropic";

export const STATELESS_PROVIDERS: readonly Provider[] = [
  "bedrock",
  "fireworks",
  "langchain",
];

export const LANGCHAIN_MODEL_PREFIXES: readonly string[] = [
  "claude-",
  "gpt-",
  "o1",
  "o3",
  "qwen.",
  "accounts/fireworks/",
  "gemini-",
];

export function isLangChainLoadableModel(model: string): boolean {
  const m = (model ?? "").trim();
  if (!m) return false;
  if (m.includes(":")) return true;
  return LANGCHAIN_MODEL_PREFIXES.some((p) => m.startsWith(p));
}

export function isStatelessProvider(provider: Provider): boolean {
  return STATELESS_PROVIDERS.includes(provider);
}

export function isAnthropicModel(model: string): boolean {
  return /^claude[-_]/i.test(model.trim());
}

export function assertModelMatchesProvider(
  provider: Provider,
  model: string,
): void {
  const m = (model ?? "").trim();
  if (m.length === 0) {
    throw new Error(
      `provider/model mismatch: model is empty for provider "${provider}".`,
    );
  }
  if (provider === "langchain") {
    if (!isLangChainLoadableModel(m)) {
      throw new Error(
        `provider/model mismatch: provider="langchain" but model="${m}" has no ` +
          `inferable vendor. Use a known prefix (${LANGCHAIN_MODEL_PREFIXES.join(", ")}) ` +
          `or write it explicitly as "<vendor>:<model>" (e.g. "anthropic:${m}").`,
      );
    }
    return;
  }

  if (provider === "openrouter") {
    if (!/^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(m)) {
      throw new Error(
        `provider/model mismatch: provider="openrouter" but model="${m}" is not ` +
          `a "<vendor>/<model>" OpenRouter id (e.g. "qwen/qwen3-coder").`,
      );
    }
    return;
  }

  const claude = isAnthropicModel(m);
  if (provider !== "anthropic" && claude) {
    const example =
      provider === "bedrock"
        ? `a Bedrock model (e.g. "${MODELS.bedrock.qwen3Next80b}")`
        : provider === "fireworks"
          ? `a Fireworks model (e.g. "${MODELS.fireworks.glm52}")`
          : `an OpenAI model (e.g. "${MODELS.openai.flagship}")`;
    throw new Error(
      `provider/model mismatch: provider="${provider}" but model="${m}" is an ` +
        `Anthropic (Claude) model. Set metadata_praxis.model to ${example} ` +
        `when flipping an agent to provider:"${provider}".`,
    );
  }
  if (provider === "anthropic" && !claude) {
    throw new Error(
      `provider/model mismatch: provider="anthropic" but model="${m}" is not ` +
        `a Claude model. Set metadata_praxis.model to a Claude model ` +
        `(e.g. "${MODELS.anthropic.opus}").`,
    );
  }
  if (provider === "bedrock") {
    const known = (Object.values(MODELS.bedrock) as string[]).includes(m);
    if (!known) {
      throw new Error(
        `provider/model mismatch: provider="bedrock" but model="${m}" is not a ` +
          `known Bedrock model id. Use one of: ` +
          `${(Object.values(MODELS.bedrock) as string[]).join(", ")} ` +
          `(add new ids to MODELS.bedrock first).`,
      );
    }
  }
  if (provider === "fireworks") {
    const known = (Object.values(MODELS.fireworks) as string[]).includes(m);
    if (!known) {
      throw new Error(
        `provider/model mismatch: provider="fireworks" but model="${m}" is not a ` +
          `known Fireworks model id. Use one of: ` +
          `${(Object.values(MODELS.fireworks) as string[]).join(", ")} ` +
          `(add new ids to MODELS.fireworks first).`,
      );
    }
  }
}

export type ModelCapabilities = {
  contextLimit: number;
  reasoning: boolean;
  supportsToolUse: boolean;
  suppressStructuredOutput: boolean;
};

export const MODEL_CAPABILITIES: Record<string, ModelCapabilities> = {
  [MODELS.anthropic.opus]: {
    contextLimit: 1_000_000,
    reasoning: true,
    supportsToolUse: true,
    suppressStructuredOutput: false,
  },
  [MODELS.anthropic.sonnet]: {
    contextLimit: 1_000_000,
    reasoning: true,
    supportsToolUse: true,
    suppressStructuredOutput: false,
  },
  [MODELS.anthropic.haiku]: {
    contextLimit: 200_000,
    reasoning: false,
    supportsToolUse: true,
    suppressStructuredOutput: false,
  },
  [MODELS.openai.flagship]: {
    contextLimit: 400_000,
    reasoning: true,
    supportsToolUse: true,
    suppressStructuredOutput: false,
  },
  [MODELS.bedrock.qwen3Next80b]: {
    contextLimit: 256_000,
    reasoning: false,
    supportsToolUse: true,
    suppressStructuredOutput: false,
  },
  [MODELS.bedrock.judgeMistralLarge3]: {
    contextLimit: 128_000,
    reasoning: false,
    supportsToolUse: true,
    suppressStructuredOutput: false,
  },
  [MODELS.bedrock.judgeDeepseekV32]: {
    contextLimit: 128_000,
    reasoning: false,
    supportsToolUse: true,
    suppressStructuredOutput: false,
  },
  [MODELS.bedrock.judgeDeepseekV31]: {
    contextLimit: 128_000,
    reasoning: false,
    supportsToolUse: true,
    suppressStructuredOutput: false,
  },
  [MODELS.bedrock.glm5]: {
    contextLimit: 200_000,
    reasoning: true,
    supportsToolUse: true,
    suppressStructuredOutput: false,
  },
  [MODELS.fireworks.glm52]: {
    contextLimit: 1_000_000,
    reasoning: true,
    supportsToolUse: true,
    suppressStructuredOutput: false,
  },
  [MODELS.fireworks.kimiK3]: {
    contextLimit: 1_000_000,
    reasoning: true,
    supportsToolUse: true,
    suppressStructuredOutput: false,
  },
};

export function getModelCapabilities(model: string): ModelCapabilities | null {
  return MODEL_CAPABILITIES[(model ?? "").trim()] ?? null;
}

export function modelSuppressesStructuredOutput(
  model: string,
  provider?: Provider,
): boolean {
  const m = (model ?? "").trim();
  if (provider === "openrouter" && m.startsWith("anthropic/")) return true;
  const cap = getModelCapabilities(m);
  if (cap) return cap.suppressStructuredOutput;

  const curated =
    provider === "bedrock" || provider === "fireworks"
      ? (Object.values(
          provider === "bedrock" ? MODELS.bedrock : MODELS.fireworks,
        ) as string[])
      : null;
  if (curated?.includes(m)) {
    throw new Error(
      `model "${m}" is registered in MODELS.${provider} but has no ` +
        `MODEL_CAPABILITIES entry. Add one (contextLimit, reasoning, ` +
        `supportsToolUse, suppressStructuredOutput) before routing to it — ` +
        `refusing to guess structured-output support on a curated provider.`,
    );
  }
  return false;
}

export function isFixedTemperatureModel(model: string): boolean {
  const cap = getModelCapabilities(model);
  if (cap) return cap.reasoning;
  return /^(gpt-5|o\d)/i.test((model ?? "").trim());
}
