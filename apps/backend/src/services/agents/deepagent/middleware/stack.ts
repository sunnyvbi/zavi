
import {
  modelFallbackMiddleware,
  todoListMiddleware,
  toolCallLimitMiddleware,
  toolRetryMiddleware,
  createMiddleware,
} from "langchain";
import type { AgentEngineRunSpec } from "../../engine/types";
import { deepAgentFallbackModelId } from "../resolve-model";
import { loadSkillFiles } from "../skills";

export const MAX_NUDGES = 2;

export type Verifier = {
  id: string;
  check: (text: string) => Promise<string | null> | string | null;
};

export function groundingMiddleware(verifiers: readonly Verifier[]) {
  const used = new Map<string, number>();
  const afterModel = async (state: { messages: Array<{ content?: unknown }> }) => {
      const last = state.messages?.[state.messages.length - 1];
      const text = typeof last?.content === "string" ? last.content : "";
      if (!text.trim()) return;

      const corrections: string[] = [];
      for (const v of verifiers) {
        const spent = used.get(v.id) ?? 0;
        if (spent >= MAX_NUDGES) continue;
        let out: string | null = null;
        try {
          out = await v.check(text);
        } catch {
          out = null;
        }
        if (out) {
          used.set(v.id, spent + 1);
          corrections.push(out);
        }
      }
      if (corrections.length === 0) return;

      return {
        messages: [
          {
            role: "user" as const,
            content:
              "Before you continue, fix the following in your last message:\n\n" +
              corrections.map((c, i) => `${i + 1}. ${c}`).join("\n") +
              "\n\nRe-read the supporting data or remove the unsupported claim. " +
              "Do not restate the claim with hedging language.",
          },
        ],
        jumpTo: "model" as const,
      };
  };

  return createMiddleware({
    name: "ZaviGroundingGate",
    afterModel: {
      canJumpTo: ["model"],
      hook: afterModel,
    } as never,
  });
}

export function skillSeedMiddleware(files: Record<string, unknown>) {
  return createMiddleware({
    name: "ZaviSkillSeed",
    beforeAgent: ((state: { files?: Record<string, unknown> }) => {
      const existing = state?.files ?? {};
      const alreadySeeded = Object.keys(existing).some((p) => p.startsWith("/skills/"));
      if (alreadySeeded) return;
      return { files: { ...existing, ...files } };
    }) as never,
  });
}

export type StackOptions = {
  spec: AgentEngineRunSpec;
  verifiers?: readonly Verifier[];
  fallbackModel?: string;
};

export function buildMiddleware(opts: StackOptions) {
  const { spec, verifiers = [], fallbackModel } = opts;

  const mw: unknown[] = [];

  mw.push(skillSeedMiddleware(loadSkillFiles()));

  if (verifiers.length > 0) mw.push(groundingMiddleware(verifiers));

  mw.push(
    toolCallLimitMiddleware({ runLimit: Math.max(spec.maxTurns, 10) }),
    toolCallLimitMiddleware({ toolName: "web_search__search", runLimit: 3 }),
  );

  mw.push(toolRetryMiddleware({ maxRetries: 2 }));

  const fallback = fallbackModel ?? deepAgentFallbackModelId();
  if (fallback) mw.push(modelFallbackMiddleware(fallback));

  mw.push(todoListMiddleware());

  return mw;
}
