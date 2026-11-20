
import { createDeepAgent } from "deepagents";
import type { NormalizedUsage } from "@/services/llm/normalize-usage";
import type {
  AgentEngine,
  AgentEngineRunSpec,
  EngineEvent,
} from "../engine/types";
import { estimateEngineCostUsd, pricingVendorForModelId, bareModelId } from "@/services/llm/engine-cost";
import { toOpenAiStrictSchema } from "../engine/strict-schema";
import { deepAgentModelId, resolveDeepAgentModel, type DeepAgentModel } from "./resolve-model";
import { buildLangChainTools } from "./tool-bridge";
import { applyDeepAgentProfile } from "./apply-profile";
import { resolveDeepAgentProfile } from "./resolve-profile";
import { buildSubagents } from "./subagents";
import { buildMiddleware, type Verifier } from "./middleware/stack";
import { loadSkillFiles, SKILLS_MOUNT } from "./skills";

const ZERO: NormalizedUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

export function accumulateUsage(acc: NormalizedUsage, raw: unknown): NormalizedUsage {
  if (!raw || typeof raw !== "object") return acc;
  const u = raw as Record<string, unknown>;
  const details = (u.input_token_details ?? {}) as Record<string, unknown>;
  return {
    input_tokens: acc.input_tokens + num(u.input_tokens),
    output_tokens: acc.output_tokens + num(u.output_tokens),
    cache_read_input_tokens: acc.cache_read_input_tokens + num(details.cache_read),
    cache_creation_input_tokens:
      acc.cache_creation_input_tokens + num(details.cache_creation),
  };
}

export function readChunk(chunk: unknown): { mode: string; payload: unknown } {
  if (!Array.isArray(chunk)) return { mode: "values", payload: chunk };
  if (chunk.length >= 3 && typeof chunk[1] === "string") {
    return { mode: chunk[1] as string, payload: chunk[2] };
  }
  if (chunk.length === 2 && typeof chunk[0] === "string") {
    return { mode: chunk[0] as string, payload: chunk[1] };
  }
  return { mode: "values", payload: chunk[chunk.length - 1] };
}

function messageFrom(payload: unknown): Record<string, unknown> | null {
  const m = Array.isArray(payload) ? payload[0] : payload;
  return m && typeof m === "object" ? (m as Record<string, unknown>) : null;
}

function textOf(msg: Record<string, unknown>): string {
  const c = msg.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((b) =>
        b && typeof b === "object" && (b as { type?: string }).type === "text"
          ? String((b as { text?: unknown }).text ?? "")
          : "",
      )
      .join("");
  }
  return "";
}

export function isGraphRecursionError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const err = e as { name?: unknown; message?: unknown };
  const name = typeof err.name === "string" ? err.name : "";
  const msg = typeof err.message === "string" ? err.message : "";
  return name === "GraphRecursionError" || /recursion limit of \d+ reached/i.test(msg);
}

export type LangChainEngineOptions = {
  verifiers?: readonly Verifier[];
  fallbackModel?: string;
  mountMemory?: boolean;
};

export async function buildDeepAgent(
  spec: AgentEngineRunSpec,
  opts: LangChainEngineOptions & { model: DeepAgentModel },
) {
  const tenantId = spec.tenantId;

  const { buildBackend, ZAVI_FS_PERMISSIONS } = await import("./backends/mount");

  const profile = resolveDeepAgentProfile(opts.model);
  const systemPrompt = applyDeepAgentProfile(spec.systemPrompt, profile);

  return createDeepAgent({
    model: opts.model,
    systemPrompt,
    tools: buildLangChainTools(spec),
    backend: buildBackend({
      tenantId: tenantId ?? "",
      runId: spec.runId ?? null,
      agentSlug: null,
      mountMemory: opts.mountMemory !== false && Boolean(tenantId),
    }),
    permissions: [...ZAVI_FS_PERMISSIONS],
    skills: [SKILLS_MOUNT],
    subagents: buildSubagents(spec, profile),
    middleware: buildMiddleware({
      spec,
      verifiers: opts.verifiers,
      fallbackModel: opts.fallbackModel,
    }) as never,
    ...(spec.outputJsonSchema
      ? {
          responseFormat: toOpenAiStrictSchema(
            spec.outputJsonSchema.schema,
          ) as never,
        }
      : {}),
  } as never);
}

export function buildAgentInput(spec: AgentEngineRunSpec) {
  return {
    messages: [{ role: "user", content: spec.userPrompt as never }],
    files: loadSkillFiles(),
  };
}

export class LangChainDeepAgentEngine implements AgentEngine {
  readonly provider = "langchain" as const;

  constructor(private readonly opts: LangChainEngineOptions = {}) {}

  async *run(spec: AgentEngineRunSpec): AsyncIterable<EngineEvent> {
    if (!spec.tenantId && this.opts.mountMemory !== false) {
      console.warn("[deepagent] no tenantId on run spec — /memory/ will not be mounted");
    }

    const langChainModelId = deepAgentModelId(spec.model);
    const agent = await buildDeepAgent(spec, {
      ...this.opts,
      model: resolveDeepAgentModel(langChainModelId),
    });

    const emit = (e: EngineEvent): EngineEvent => {
      spec.onEvent(e);
      return e;
    };

    let usage = ZERO;
    let sawText = false;
    let structured: unknown = null;

    const stream = await (agent as unknown as {
      stream: (input: unknown, cfg: unknown) => Promise<AsyncIterable<unknown>>;
    }).stream(
      buildAgentInput(spec),
      {
        streamMode: ["messages", "values"],
        subgraphs: true,
        recursionLimit: Math.max(spec.maxTurns * 4 + 10, 40),
        signal: spec.abort.signal,
      },
    );

    let hitGraphBudget = false;
    try {
    for await (const chunk of stream) {
      const { mode, payload } = readChunk(chunk);
      if (mode === "values") {
        const v = payload as { structuredResponse?: unknown } | null;
        if (v && typeof v === "object" && v.structuredResponse != null) {
          structured = v.structuredResponse;
        }
        continue;
      }
      if (mode !== "messages") continue;
      const msg = messageFrom(payload);
      if (!msg) continue;

      const meta = Array.isArray(payload) ? (payload[1] as Record<string, unknown>) : undefined;
      const isSummarization = meta?.lcSource === "summarization";

      usage = accumulateUsage(usage, msg.usage_metadata);

      if (!isSummarization) {
        const text = textOf(msg);
        if (text) {
          sawText = true;
          yield emit({ type: "text_delta", text });
        }
      }
    }
    } catch (e) {
      if (!isGraphRecursionError(e)) throw e;
      hitGraphBudget = true;
      console.warn(
        `[deepagent] graph recursion budget reached (run=${spec.runId ?? "n/a"}) — ` +
          `returning the partial answer as error_max_turns`,
      );
    }

    yield emit({ type: "usage", usage });
    yield emit({
      type: "terminal",
      resume: null,
      usage,
      costUsd: estimateEngineCostUsd(
        pricingVendorForModelId(langChainModelId),
        bareModelId(langChainModelId),
        usage,
      ),
      ...(structured != null ? { structuredOutput: structured } : {}),
      stopReason: hitGraphBudget
        ? "error_max_turns"
        : sawText || structured != null
          ? "end_turn"
          : "error_during_execution",
    });
  }
}
