
import { isLangChainLoadableModel } from "@/services/llm/models";

export { isLangChainLoadableModel };

export function toLangChainModelId(model: string): string {
  const m = (model ?? "").trim();
  if (!m) throw new Error("toLangChainModelId: empty model id");
  if (m.includes(":")) return m;
  if (m.startsWith("claude-")) return `anthropic:${m}`;
  if (m.startsWith("gpt-") || m.startsWith("o1") || m.startsWith("o3")) return `openai:${m}`;
  if (m.startsWith("qwen.") || m.startsWith("accounts/fireworks/")) return `fireworks:${m}`;
  if (m.startsWith("gemini-")) return `google-genai:${m}`;
  throw new Error(
    `toLangChainModelId: cannot infer a provider for model "${m}". ` +
      `Declare it in agent.md as "<provider>:<model>" (e.g. "anthropic:${m}").`,
  );
}
