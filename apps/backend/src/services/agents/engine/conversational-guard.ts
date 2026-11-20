
import type { Provider } from "@/services/llm/models";
import { isStatelessProvider } from "@/services/llm/models";
import { isShadowCanaryConversationalExcluded } from "@/services/eval/engine-parity/shadow-canary-agents";

export function isDeepAgentConversationalAllowed(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.PRAXIS_DEEPAGENT_ALLOW_CONVERSATIONAL === "1";
}

const INLINE_PINNED_AGENTS = new Set(["operator"]);

export function refusesConversationalAgent(
  provider: Provider,
  slug: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!isStatelessProvider(provider)) return false;
  if (!isShadowCanaryConversationalExcluded(slug)) return false;
  if (
    provider === "langchain" &&
    !INLINE_PINNED_AGENTS.has((slug ?? "").trim()) &&
    isDeepAgentConversationalAllowed(env)
  ) {
    return false;
  }
  return true;
}
