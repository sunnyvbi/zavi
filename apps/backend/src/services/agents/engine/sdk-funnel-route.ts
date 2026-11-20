
import type { Provider } from "@/services/llm/models";

export type SdkFunnelRoute =
  | "inline_anthropic"
  | "anthropic_engine"
  | "alt_provider";

export interface SdkFunnelDecision {
  route: SdkFunnelRoute;
  providerForRun: Provider;
  useAnthropicEngine: boolean;
  operatorPinned: boolean;
  operatorGateOnAltFunnel: boolean;
}

export function resolveLiveSdkFunnel(args: {
  agentSlug: string;
  resolvedProvider: Provider;
  anthropicEngineEnabled: boolean;
  staffModel?: boolean;
  pinInline?: boolean;
}): SdkFunnelDecision {
  if (args.pinInline) {
    return { route: "inline_anthropic", providerForRun: "anthropic", useAnthropicEngine: false, operatorPinned: false, operatorGateOnAltFunnel: false };
  }
  if (args.staffModel) {
    return {
      route: "alt_provider",
      providerForRun: "openrouter",
      useAnthropicEngine: false,
      operatorPinned: false,
      operatorGateOnAltFunnel: args.agentSlug === "operator",
    };
  }

  const operatorPinned = args.agentSlug === "operator";

  const providerForRun: Provider = operatorPinned
    ? "anthropic"
    : args.resolvedProvider;
  const useAnthropicEngine =
    providerForRun === "anthropic" &&
    !operatorPinned &&
    args.anthropicEngineEnabled;

  const route: SdkFunnelRoute =
    providerForRun === "anthropic"
      ? useAnthropicEngine
        ? "anthropic_engine"
        : "inline_anthropic"
      : "alt_provider";

  return { route, providerForRun, useAnthropicEngine, operatorPinned, operatorGateOnAltFunnel: false };
}
