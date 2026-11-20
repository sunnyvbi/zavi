import { MODEL_MANIFEST } from "@/services/eval/model-bench/manifest";
import { MODELS } from "@/services/llm/models";

export type StaffModel =
  | { kind: "openrouter"; key: string; model_id: string; upstream: string; label: string }
  | { kind: "claude"; key: string; model_id: string; effort: "medium" | "high" | "xhigh"; label: string };

const CLAUDE_VARIANTS: Record<string, { model_id: string; effort: "medium" | "high" | "xhigh"; label: string }> = {
  sonnet: { model_id: MODELS.anthropic.sonnet, effort: "medium", label: "Sonnet (medium)" },
  "sonnet-high": { model_id: MODELS.anthropic.sonnet, effort: "high", label: "Sonnet (high)" },
  "sonnet-xhigh": { model_id: MODELS.anthropic.sonnet, effort: "xhigh", label: "Sonnet (xhigh)" },
  opus: { model_id: MODELS.anthropic.opus, effort: "medium", label: "Opus (medium)" },
  "opus-high": { model_id: MODELS.anthropic.opus, effort: "high", label: "Opus (high)" },
  "opus-xhigh": { model_id: MODELS.anthropic.opus, effort: "xhigh", label: "Opus (xhigh)" },
};

const SHORT_TO_BENCH: Record<string, { bench: string; label: string; upstream?: string }> = {
  openai: { bench: "gpt-5.5", label: "GPT-5.5" },
  "gpt-6-sol": { bench: "gpt-6-sol", label: "GPT-6 Sol" },
  "gpt-5.6-luna": { bench: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
  gemini: { bench: "gemini-pro", label: "Gemini 3.1 Pro" },
  mistral: { bench: "mistral", label: "Mistral Medium 3.5" },
  deepseek: { bench: "deepseek", label: "DeepSeek V4 Pro" },
  qwen: { bench: "qwen", label: "Qwen3.8 27B", upstream: "DeepInfra" },
  kimi: { bench: "kimi", label: "Kimi K3" },
  glm: { bench: "glm", label: "GLM-5.3" },
};

export const STAFF_MODEL_NAMES: readonly string[] = ["claude", ...Object.keys(CLAUDE_VARIANTS), ...Object.keys(SHORT_TO_BENCH)];

export function isClaudeKey(raw: string): boolean {
  return raw.trim().toLowerCase() === "claude";
}

export function resolveStaffModel(raw: string): StaffModel | null {
  const key = raw.trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(CLAUDE_VARIANTS, key) && !Object.prototype.hasOwnProperty.call(SHORT_TO_BENCH, key)) return null;
  const c = CLAUDE_VARIANTS[key];
  if (c) return { kind: "claude", key, ...c };
  const m = SHORT_TO_BENCH[key];
  if (!m) return null;
  const entry = MODEL_MANIFEST.get(m.bench);
  if (!entry || !entry.upstream || entry.route !== "shared_loop") return null;
  return { kind: "openrouter", key, model_id: entry.model_id, upstream: m.upstream ?? entry.upstream, label: m.label };
}
