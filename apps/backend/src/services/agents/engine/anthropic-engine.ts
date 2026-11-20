
import { existsSync } from "node:fs";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";

import {
  resolveAgentAuthMode,
  buildAgentChildEnv,
  preferApiKeyFromEnv,
  resolveOAuthTokenPool,
  nextStartOffset,
  markTokenCooldown,
  benchSeatForLimit,
  resolveAttemptTokens,
  shouldRotateOnUsageLimit,
} from "@/services/agents/agent-auth";
import { withAgentSdkIsolation } from "../sdk-isolation";
import { isProviderCapNotice, isProviderSeatDisabledNotice, isUsageLimitError, tagSeatAuthError } from "@/services/agents/infra-retry";
import { seatLabelForAuth, seatLabelForToken } from "@/services/agents/seat-identity";
import { holdSeat } from "@/services/agents/seat-usage-store";
import { fromAnthropicName } from "@/services/mcp/types";
import { normalizeUsage } from "@/services/llm/normalize-usage";
import { assertModelMatchesProvider, MODELS } from "@/services/llm/models";
import type {
  AgentEngine,
  AgentEngineRunSpec,
  EngineEvent,
  EngineToolCall,
  EngineToolSpec,
  UserContent,
} from "./types";
import {
  buildToolInputShape,
  repairArgsFromSchema,
  sdkToolDescription,
  unwrapToolArgs,
} from "../sdk/tool-input-shape";
import { buildSteerablePromptStream } from "./steerable-prompt";
import { reportSteerDrainFailure } from "../steer-channel-alert";
import { SDK_DISALLOWED_BUILTINS } from "../sdk-builtins";
import { modelRefusalError, nextRefusalState, type SdkRefusal } from "../sdk-refusal";
import { noteSeatDisabled } from "../seat-disabled-alert";

function resolveClaudeBinary(): string | undefined {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const platform = process.platform;
  const arch = process.arch;
  const exe = platform === "win32" ? ".exe" : "";
  const candidates =
    platform === "linux"
      ? [
          `@anthropic-ai/claude-agent-sdk-linux-${arch}/claude${exe}`,
          `@anthropic-ai/claude-agent-sdk-linux-${arch}-musl/claude${exe}`,
        ]
      : [`@anthropic-ai/claude-agent-sdk-${platform}-${arch}/claude${exe}`];
  for (const cand of candidates) {
    try {
      const resolved = require.resolve(cand);
      if (existsSync(resolved)) return resolved;
    } catch {
    }
  }
  return undefined;
}

async function buildMcpServer(
  spec: AgentEngineRunSpec,
  runId: string,
): Promise<{
  mcpServers: Record<string, unknown>;
}> {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  const { createSdkMcpServer } = sdk;
  const sdkTool = sdk.tool as unknown as (
    name: string,
    description: string,
    inputSchema: Record<string, unknown>,
    handler: (
      args: unknown,
      extra: unknown,
    ) => Promise<{
      content: Array<{ type: "text"; text: string }>;
      isError?: boolean;
    }>,
  ) => unknown;

  const sdkTools = spec.tools.map((t: EngineToolSpec) => {
    const parts = fromAnthropicName(t.name);
    if (!parts) {
      throw new Error(`anthropic-engine: malformed tool name '${t.name}'`);
    }
    const description = sdkToolDescription(t.description, t.jsonSchema);
    const { shape: toolShape, declaresOwnInput } = buildToolInputShape(t.jsonSchema);

    let invocationSeq = 0;
    return sdkTool(
      t.name,
      description,
      toolShape as unknown as Record<string, unknown>,
      async (args: unknown) => {
        try {
          const realInput = repairArgsFromSchema(
            t.jsonSchema,
            unwrapToolArgs(args, declaresOwnInput),
          );
          const tool_use_id = `${runId}__${t.name}__inv${invocationSeq++}`;
          const call: EngineToolCall = {
            tool_name: t.name,
            server_id: parts.server_id,
            bare_tool_name: parts.tool_name,
            input: realInput,
            tool_use_id,
          };
          const result = await spec.dispatchTool(call);
          if (result.is_error) {
            return {
              content: [{ type: "text" as const, text: result.content }],
              isError: true,
            };
          }
          return {
            content: [
              {
                type: "text" as const,
                text:
                  typeof result.content === "string"
                    ? result.content
                    : JSON.stringify(result.content),
              },
            ],
          };
        } catch (e) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: "dispatch_failed",
                  message: (e as Error).message,
                }),
              },
            ],
            isError: true,
          };
        }
      },
    );
  });

  const server = createSdkMcpServer({
    name: "praxis-server",
    version: "0.1.0",
    tools: sdkTools as never,
  });

  return { mcpServers: { server: server as unknown } };
}

function mintRunId(): string {
  try {
    const u = (globalThis.crypto as { randomUUID?: () => string }).randomUUID?.();
    if (u) return `run_${u}`;
  } catch {
  }
  return `run_${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

export class AnthropicAgentEngine implements AgentEngine {
  readonly provider = "anthropic" as const;

  async *run(spec: AgentEngineRunSpec): AsyncIterable<EngineEvent> {
    assertModelMatchesProvider("anthropic", spec.model);

    const apiKey = process.env.ANTHROPIC_API_KEY;
    const preferApiKey = preferApiKeyFromEnv();
    const tokenPool = resolveOAuthTokenPool();
    const attemptTokens = resolveAttemptTokens({
      pool: tokenPool,
      apiKey,
      preferApiKey,
      startOffset: nextStartOffset(tokenPool.length),
    });

    const runId = mintRunId();
    const { mcpServers } = await buildMcpServer(spec, runId);

    const resumeSessionId =
      spec.resume && spec.resume.kind === "sdk_session"
        ? spec.resume.sessionId
        : undefined;

    const buf: EngineEvent[] = [];
    let attemptDirty = false;
    const emit = (e: EngineEvent): void => {
      attemptDirty = true;
      spec.onEvent(e);
      buf.push(e);
    };
    const drain = function* (): Generator<EngineEvent> {
      while (buf.length) yield buf.shift() as EngineEvent;
    };

    const { query } = await import("@anthropic-ai/claude-agent-sdk");

    for (let attempt = 0; attempt < attemptTokens.length; attempt++) {
      const token = attemptTokens[attempt];
      const hasMoreTokens = attempt < attemptTokens.length - 1;
      attemptDirty = false;
      const sdkAuthMode = resolveAgentAuthMode({
        oauthToken: token,
        apiKey,
        preferApiKey,
      });
      const sdkChildEnv = buildAgentChildEnv({
        mode: sdkAuthMode,
        oauthToken: token,
        apiKey,
        ...(spec.promptCacheTtl ? { promptCacheTtl: spec.promptCacheTtl } : {}),
      });

    const promptAbort = new AbortController();
    const forwardPromptAbort = () => promptAbort.abort();
    const releaseSeat = sdkAuthMode === "oauth" && token ? holdSeat(seatLabelForToken(token)) : () => {};
    const modelIdle = { value: false };

    const stream = query({
      prompt: buildSteerablePromptStream(spec.userPrompt, runId, {
        steerSource: spec.steerSource,
        signal: promptAbort.signal,
        onSteerDrained: (count, turn) =>
          emit({ type: "steer_drained", count, iter: turn }),
        modelIdle,
        onDrainFailure: (f) =>
          reportSteerDrainFailure({
            run_id: runId,
            tenant_id: spec.tenantId ?? "unknown",
            agent_slug: "unknown",
            ...f,
          }),
      }),
      options: withAgentSdkIsolation({
        env: sdkChildEnv as { [k: string]: string | undefined },
        abortController: spec.abort,
        systemPrompt: spec.systemPrompt,
        model: spec.model,
        ...(spec.model === MODELS.anthropic.opus
          ? { effort: spec.effort ?? ("high" as const) }
          : spec.effort
            ? { effort: spec.effort }
            : {}),
        mcpServers: mcpServers as Record<string, never>,
        maxTurns: spec.maxTurns,
        ...(spec.outputJsonSchema
          ? {
              outputFormat: {
                type: "json_schema" as const,
                schema: spec.outputJsonSchema.schema,
              },
            }
          : {}),
        ...(resumeSessionId ? { resume: resumeSessionId } : {}),
        disallowedTools: [...SDK_DISALLOWED_BUILTINS],
        pathToClaudeCodeExecutable: resolveClaudeBinary(),
        canUseTool: async (toolName: string, input: Record<string, unknown>) => {
          emit({ type: "tool_start", name: toolName, input });
          return { behavior: "allow" as const, updatedInput: input };
        },
      }),
    });

    if (spec.abort.signal.aborted) promptAbort.abort();
    else
      spec.abort.signal.addEventListener("abort", forwardPromptAbort, {
        once: true,
      });

    let iter = 0;
    let assistantTextBlockSeen = false;
    let rotated = false;
    let refusal: SdkRefusal | null = null;

    try {
    for await (const message of stream) {
      refusal = nextRefusalState(refusal, message);
      yield* drain();
      iter += 1;

      if (message.type === "assistant") {
        const blocks = ((message as { message?: { content?: unknown } }).message
          ?.content ?? []) as Array<{
          type: string;
          text?: string;
          name?: string;
          input?: unknown;
          id?: string;
        }>;
        emit({
          type: "assistant_turn",
          hadContent: blocks.length > 0,
          iter,
        });
        const turnUsage = (message as { message?: { usage?: unknown } }).message
          ?.usage;
        if (turnUsage) {
          emit({ type: "usage", usage: normalizeUsage(turnUsage, "anthropic") });
        }
        for (const block of blocks) {
          if (block.type === "text" && typeof block.text === "string") {
            const isFirstTextBlock = !assistantTextBlockSeen;
            assistantTextBlockSeen = true;
            if (sdkAuthMode === "oauth" && isProviderSeatDisabledNotice(block.text)) {
              void noteSeatDisabled({ token, text: block.text, runId: spec.runId, tenantId: spec.tenantId, rotated: false });
            }
            emit({
              type: "assistant_text",
              text: block.text,
              isFirstTextBlock,
              iter,
            });
          } else if (block.type === "tool_use") {
            emit({
              type: "tool_use",
              name: String(block.name ?? "unknown"),
              input: block.input,
              tool_use_id:
                typeof block.id === "string" && block.id ? block.id : "",
              iter,
            });
          }
        }
      } else if (message.type === "user") {
        const blocks = ((message as { message?: { content?: unknown } }).message
          ?.content ?? []) as Array<{
          type: string;
          tool_use_id?: string;
          content?: unknown;
          is_error?: boolean;
        }>;
        for (const block of blocks) {
          if (block.type !== "tool_result") continue;
          emit({
            type: "tool_result",
            tool_use_id:
              typeof block.tool_use_id === "string" ? block.tool_use_id : "",
            name: "",
            content: block.content,
            isError: block.is_error === true,
            ms: 0,
            iter,
          });
        }
      } else if (message.type === "result") {
        modelIdle.value = true;
        const r = message as unknown as {
          subtype?: string;
          usage?: Record<string, unknown>;
          total_cost_usd?: number;
          result?: string;
          session_id?: string;
          structured_output?: unknown;
        };
        const resultText = typeof r.result === "string" ? r.result : "";
        const rotateOnResult = shouldRotateOnUsageLimit({
          hasMoreTokens,
          attemptDirty,
          aborted: spec.abort?.signal.aborted ?? false,
          resultText,
        });
        if (
          sdkAuthMode === "oauth" &&
          ((r as { is_error?: boolean }).is_error === true || isProviderSeatDisabledNotice(resultText))
        ) {
          void noteSeatDisabled({ token, text: resultText, runId: spec.runId, tenantId: spec.tenantId, rotated: rotateOnResult });
        }
        if (rotateOnResult) {
          rotated = true;
          if (isUsageLimitError(typeof r.result === "string" ? r.result : "")) benchSeatForLimit(token, String(r.result));
          else markTokenCooldown(token);
          break;
        }
        {
          const text = typeof r.result === "string" ? r.result : "";
          const isLimit = (r as { is_error?: boolean }).is_error === true ? isUsageLimitError(text) : isProviderCapNotice(text);
          if (isLimit) benchSeatForLimit(token, text);
        }
        const usage = normalizeUsage(r.usage, "anthropic");

        if (typeof r.result === "string" && r.result.length > 0) {
          emit({
            type: "assistant_text",
            text: r.result,
            isFirstTextBlock: !assistantTextBlockSeen,
            iter,
          });
          assistantTextBlockSeen = true;
        }

        const stopReason =
          r.subtype === "success" ? "end_turn" : r.subtype ?? "unknown";

        emit({
          type: "terminal",
          resume:
            typeof r.session_id === "string" && r.session_id.length > 0
              ? { kind: "sdk_session", sessionId: r.session_id }
              : null,
          usage,
          ...(typeof r.total_cost_usd === "number"
            ? { costUsd: r.total_cost_usd }
            : {}),
          authSeat: seatLabelForAuth({ mode: sdkAuthMode, token }),
          stopReason,
          ...(r.structured_output != null
            ? { structuredOutput: r.structured_output }
            : {}),
        });
      }
    }
    } catch (err) {
      const rotateOnThrow = shouldRotateOnUsageLimit({
        hasMoreTokens,
        attemptDirty,
        aborted: spec.abort?.signal.aborted ?? false,
        resultText: (err as Error)?.message ?? "",
      });
      if (sdkAuthMode === "oauth") {
        void noteSeatDisabled({
          token,
          text: (err as Error)?.message ?? "",
          runId: spec.runId,
          tenantId: spec.tenantId,
          rotated: rotateOnThrow,
        });
      }
      if (rotateOnThrow) {
        if (isUsageLimitError((err as Error)?.message ?? "")) benchSeatForLimit(token, (err as Error).message);
        else markTokenCooldown(token);
        continue;
      }
      if (isUsageLimitError((err as Error)?.message ?? "")) benchSeatForLimit(token, (err as Error).message);
      throw tagSeatAuthError(err);
    } finally {
      promptAbort.abort();
      spec.abort.signal.removeEventListener("abort", forwardPromptAbort);
      releaseSeat();
    }

    if (rotated) continue;

    if (refusal) {
      yield* drain();
      throw modelRefusalError(refusal);
    }

    yield* drain();
    return;
    }

    yield* drain();
  }
}
