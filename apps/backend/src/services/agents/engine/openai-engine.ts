
import {
  Agent,
  run,
  tool,
  RunRawModelStreamEvent,
  MaxTurnsExceededError,
  OpenAIChatCompletionsModel,
  OpenAIResponsesModel,
  type Model,
  type AgentInputItem,
  type StreamRunOptions,
} from "@openai/agents";
import OpenAI from "openai";
import { setTracingDisabled, type AgentOutputType } from "@openai/agents-core";
import type {
  JsonObjectSchemaStrict,
  JsonObjectSchemaNonStrict,
  JsonSchemaDefinition,
} from "@openai/agents-core/types";

import { getOpenAi } from "@/services/openai";
import { fromAnthropicName } from "@/services/mcp/types";
import { embedTexts } from "@/services/memory/embed";
import { getCodexClient } from "@/services/codex-subscription";
import {
  OPENROUTER_BASE_URL,
  OpenRouterRunRecorder,
  makeOpenRouterFetch,
  registerOpenRouterRecorder,
  type OpenRouterPin,
} from "@/services/llm/openrouter";
import {
  assertModelMatchesProvider,
  modelSuppressesStructuredOutput,
} from "@/services/llm/models";
import { toOpenAiStrictSchema, isStrictExpressible, reconcileOpenAiStrictToolInput } from "./strict-schema";
import {
  SEARCH_TOOLS_DESCRIPTION,
  SEARCH_TOOLS_NAME,
  SEARCH_TOOLS_PARAMETERS,
  TOOL_SEARCH_PROMPT_SUFFIX,
  TOOL_SEARCH_START_CAP,
  TOOL_SEARCH_MAX_DEF_CHARS,
  computeStartingSet,
  createToolSearch,
  toolNotFoundMessage,
  type EmbedFn,
  type ToolSearchState,
} from "./tool-search";
import { TurnHookModel } from "./turn-hook-model";

setTracingDisabled(true);
import { normalizeUsage } from "@/services/llm/normalize-usage";
import type { NormalizedUsage } from "@/services/llm/normalize-usage";
import type {
  AgentEngine,
  AgentEngineRunSpec,
  EngineEvent,
  EngineToolCall,
  EngineToolSpec,
  UserContent,
} from "./types";

type OpenAiUserPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image: string };

function mapUserContentToInput(content: UserContent): AgentInputItem[] {
  if (typeof content === "string") {
    return [
      {
        role: "user",
        content: [{ type: "input_text", text: content }],
      } as AgentInputItem,
    ];
  }

  const parts: OpenAiUserPart[] = [];
  for (const block of content) {
    if (block.type === "text") {
      parts.push({ type: "input_text", text: block.text });
      continue;
    }
    if (block.type === "image") {
      const src = block.source as {
        type?: string;
        media_type?: string;
        data?: string;
        url?: string;
      };
      if (src.type === "base64" && src.data) {
        parts.push({
          type: "input_image",
          image: `data:${src.media_type ?? "image/png"};base64,${src.data}`,
        });
        continue;
      }
      if (src.type === "url" && typeof src.url === "string") {
        parts.push({ type: "input_image", image: src.url });
        continue;
      }
      parts.push({ type: "input_text", text: JSON.stringify(block) });
      continue;
    }
    if ((block as { type: string }).type === "document") {
      const title = (block as { title?: unknown }).title;
      parts.push({
        type: "input_text",
        text: `[The user attached a PDF${typeof title === "string" && title ? ` (${title})` : ""} that this model cannot read here. Say so if it matters.]`,
      });
      continue;
    }
    parts.push({ type: "input_text", text: JSON.stringify(block) });
  }

  if (parts.length === 0) {
    parts.push({ type: "input_text", text: "" });
  }

  return [{ role: "user", content: parts } as AgentInputItem];
}

function makeFunctionTool(
  spec: EngineToolSpec,
  dispatchTool: AgentEngineRunSpec["dispatchTool"],
  isEnabled?: () => boolean,
) {
  const toolStrict = isStrictExpressible(spec.jsonSchema);
  const normalized = toOpenAiStrictSchema(spec.jsonSchema);
  const execute = async (input: unknown, _runContext?: unknown, details?: unknown) => {
      const callId =
        (details as { toolCall?: { callId?: string } } | undefined)?.toolCall
          ?.callId ?? `${spec.name}:${randomId()}`;
      const call: EngineToolCall = {
        tool_name: spec.name,
        input: reconcileOpenAiStrictToolInput(input, spec.jsonSchema),
        tool_use_id: callId,
      };
      const res = await dispatchTool(call);
      return res.content;
  };
  const base = {
    name: spec.name,
    description: spec.description,
    errorFunction: null,
    execute,
    ...(isEnabled ? { isEnabled } : {}),
  } as const;
  return toolStrict
    ? tool({ ...base, parameters: normalized as JsonObjectSchemaStrict<Record<string, never>>, strict: true })
    : tool({ ...base, parameters: normalized as unknown as JsonObjectSchemaNonStrict<Record<string, never>>, strict: false });
}

function randomId(): string {
  try {
    return (globalThis.crypto as { randomUUID?: () => string }).randomUUID?.() ??
      Math.random().toString(36).slice(2);
  } catch {
    return Math.random().toString(36).slice(2);
  }
}

export function buildOpenAiAgent(
  spec: AgentEngineRunSpec,
  modelOverride?: Model,
  suppressOutputType?: boolean,
  embed?: EmbedFn,
): Agent<unknown, AgentOutputType> {
  const { tools: mappedFunctionTools, search } = mapToolsWithSearch(spec, embed ?? voyageToolEmbed);

  const strictOk = spec.outputJsonSchema
    ? isStrictExpressible(spec.outputJsonSchema.schema)
    : false;
  const outputType: AgentOutputType | undefined = spec.outputJsonSchema
    ? ({
        type: "json_schema",
        name: "agent_two_channel_output",
        strict: strictOk,
        schema: toOpenAiStrictSchema(
          spec.outputJsonSchema.schema,
        ) as unknown as JsonSchemaDefinition["schema"],
      } satisfies JsonSchemaDefinition)
    : undefined;

  const agent = new Agent({
    name: "zavi-agent",
    instructions: search
      ? `${spec.systemPrompt}\n\n${TOOL_SEARCH_PROMPT_SUFFIX}`
      : spec.systemPrompt,
    model: modelOverride ?? spec.model,
    tools: mappedFunctionTools,
    handoffs: [],
    mcpServers: [],
    ...(outputType && !suppressOutputType ? { outputType } : {}),
  }) as Agent<unknown, AgentOutputType>;
  if (search) TOOL_SEARCH_BY_AGENT.set(agent, search);
  return agent;
}

const TOOL_SEARCH_BY_AGENT = new WeakMap<object, ToolSearchState>();

const voyageToolEmbed: EmbedFn = (texts, inputType) => embedTexts(texts, inputType);

export function toolSearchStateFor(agent: object): ToolSearchState | null {
  return TOOL_SEARCH_BY_AGENT.get(agent) ?? null;
}

function mapToolsWithSearch(
  spec: AgentEngineRunSpec,
  embed: EmbedFn | undefined,
): { tools: ReturnType<typeof makeFunctionTool>[]; search: ToolSearchState | null } {
  if (spec.tools.length <= TOOL_SEARCH_START_CAP) {
    const plain = spec.tools.map((t) => makeFunctionTool(t, spec.dispatchTool));
    const totalChars = plain.reduce((sum, ft) => sum + definitionChars(ft), 0);
    if (totalChars <= TOOL_SEARCH_MAX_DEF_CHARS) return { tools: plain, search: null };
  }
  let state: ToolSearchState | null = null;
  const built = spec.tools.map((t) =>
    makeFunctionTool(t, spec.dispatchTool, () => state?.isLoaded(t.name) === true),
  );
  const taken = new Set<string>([SEARCH_TOOLS_NAME]);
  const keep: number[] = [];
  built.forEach((ft, i) => {
    const r = (ft as { name?: string }).name ?? spec.tools[i].name;
    if (taken.has(r)) {
      console.warn(
        JSON.stringify({
          event: "tool_search_name_collision",
          run_id: spec.runId ?? null,
          excluded_tool: spec.tools[i].name,
          registered_name: r,
        }),
      );
      return;
    }
    taken.add(r);
    keep.push(i);
  });
  const tools = keep.map((i) => built[i]);
  const keptSpecs = keep.map((i) => spec.tools[i]);
  const registered = keep.map((i) => (built[i] as { name?: string }).name ?? spec.tools[i].name);
  const names = keptSpecs.map((t) => t.name);
  state = createToolSearch({
    tools: keptSpecs.map((t, i) => ({
      name: t.name,
      registeredName: registered[i],
      serverId: fromAnthropicName(t.name)?.server_id ?? "",
      description: t.description ?? "",
      schemaText: safeJson(t.jsonSchema),
      defChars: definitionChars(built[keep[i]]),
    })),
    startingSet: computeStartingSet(names, spec.toolSearch),
    pinned: spec.toolSearch?.injectedToolNames,
    embed,
    runId: spec.runId,
    recordForBench: spec.toolSearch?.record === true,
  });
  const s = state;
  const searchTool = tool({
    name: SEARCH_TOOLS_NAME,
    description: SEARCH_TOOLS_DESCRIPTION,
    parameters: SEARCH_TOOLS_PARAMETERS as unknown as JsonObjectSchemaStrict<Record<string, never>>,
    strict: true,
    errorFunction: null,
    execute: async (input: unknown) => {
      const a = (input ?? {}) as { query?: unknown; k?: unknown };
      return s.search(a.query, a.k);
    },
  });
  return { tools: [...tools, searchTool], search: s };
}

function definitionChars(ft: unknown): number {
  const f = ft as { name?: string; description?: string; parameters?: unknown };
  return safeJson({ name: f.name, description: f.description ?? "", parameters: f.parameters }).length;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "";
  }
}

type ResumeMode = "openai" | "stateless";

const DEFAULT_BARGE_IN_SEGMENT_MAX_TURNS = 4;

const MAX_BARGE_IN_SEGMENTS = 24;

const ZERO_NORMALIZED_USAGE: NormalizedUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

function sumNormalizedUsage(
  a: NormalizedUsage,
  b: NormalizedUsage,
): NormalizedUsage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_input_tokens:
      a.cache_read_input_tokens + b.cache_read_input_tokens,
    cache_creation_input_tokens:
      a.cache_creation_input_tokens + b.cache_creation_input_tokens,
  };
}

interface SegmentOutcome {
  usage: NormalizedUsage;
  lastResponseId?: string;
  hard: boolean;
}

async function* runOneSegment(
  spec: AgentEngineRunSpec,
  agent: Agent<unknown, AgentOutputType>,
  input: ReturnType<typeof mapUserContentToInput>,
  previousResponseId: string | undefined,
  maxTurns: number,
  emit: (e: EngineEvent) => EngineEvent,
): AsyncGenerator<EngineEvent, SegmentOutcome> {
  const options: StreamRunOptions = {
    stream: true,
    maxTurns,
    signal: spec.abort.signal,
    ...(previousResponseId ? { previousResponseId } : {}),
    ...toolSearchRunOptions(agent),
  };

  let lastResponseId: string | undefined = previousResponseId;
  let lastRawUsage: Record<string, unknown> | undefined;
  const streamed = await run(agent, input, options);

  try {
    for await (const ev of streamed) {
      if (ev instanceof RunRawModelStreamEvent) {
        const data = ev.data as { type?: string } & Record<string, unknown>;
        if (data.type === "output_text_delta") {
          const delta = typeof data.delta === "string" ? data.delta : "";
          if (delta) yield emit({ type: "text_delta", text: delta });
          continue;
        }
        if (data.type === "response_done") {
          const response = data.response as
            | { id?: string; usage?: Record<string, unknown> }
            | undefined;
          if (response?.id) lastResponseId = response.id;
          if (response?.usage) {
            const raw = openAiUsageToRaw(response.usage);
            lastRawUsage = raw;
            yield emit({ type: "usage", usage: normalizeUsage(raw, "openai") });
          }
          continue;
        }
        continue;
      }
    }
    await streamed.completed;
  } catch (err) {
    if (streamed.lastResponseId) lastResponseId = streamed.lastResponseId;
    const usage = finalUsageFromStream(streamed, lastRawUsage);
    if (!isAbortError(err, spec) && !(err instanceof MaxTurnsExceededError)) {
      throw Object.assign(err as object, {
        __segmentUsage: usage,
        __segmentLastResponseId: lastResponseId,
      });
    }
    return { usage, lastResponseId, hard: true };
  }

  if (streamed.lastResponseId) lastResponseId = streamed.lastResponseId;
  return {
    usage: finalUsageFromStream(streamed, lastRawUsage),
    lastResponseId,
    hard: false,
  };
}

export function toolSearchRunOptions(
  agent: object,
): Pick<StreamRunOptions, "toolNotFoundBehavior" | "toolErrorFormatter"> {
  const search = toolSearchStateFor(agent);
  if (!search) return {};
  return {
    toolNotFoundBehavior: "return_error_to_model",
    toolErrorFormatter: (args) =>
      args.kind === "tool_not_found" ? toolNotFoundMessage(search, args.toolName) : undefined,
  };
}

async function* streamOpenAICompatRun(
  spec: AgentEngineRunSpec,
  agent: Agent<unknown, AgentOutputType>,
  resumeMode: ResumeMode,
): AsyncIterable<EngineEvent> {
  const emit = (e: EngineEvent): EngineEvent => {
    spec.onEvent(e);
    return e;
  };

  const makeTerminal = (
    usage: NormalizedUsage,
    lastResponseId: string | undefined,
  ): EngineEvent =>
    resumeMode === "openai"
      ? {
          type: "terminal",
          resume: lastResponseId
            ? { kind: "openai", lastResponseId }
            : { kind: "openai" },
          usage,
        }
      : { type: "terminal", resume: null, usage };

  let lastResponseId: string | undefined =
    resumeMode === "openai" && spec.resume && spec.resume.kind === "openai"
      ? spec.resume.lastResponseId
      : undefined;

  const canBargeInInRun = !!spec.steerSource && resumeMode === "openai";
  const segMaxTurns = canBargeInInRun
    ? DEFAULT_BARGE_IN_SEGMENT_MAX_TURNS
    : spec.maxTurns;

  let accUsage: NormalizedUsage = ZERO_NORMALIZED_USAGE;
  let input = mapUserContentToInput(spec.userPrompt);
  let afterSeq = 0;
  let turn = 0;
  let segmentCount = 0;
  let pendingSteers: { ids: string[]; count: number; turn: number } | null = null;

  for (;;) {
    let seg: SegmentOutcome;
    try {
      seg = yield* runOneSegment(
        spec,
        agent,
        input,
        resumeMode === "openai" ? lastResponseId : undefined,
        segMaxTurns,
        emit,
      );
    } catch (err) {
      const e = err as {
        __segmentUsage?: NormalizedUsage;
        __segmentLastResponseId?: string;
      };
      if (e.__segmentUsage) accUsage = sumNormalizedUsage(accUsage, e.__segmentUsage);
      if (e.__segmentLastResponseId) lastResponseId = e.__segmentLastResponseId;
      yield emit(makeTerminal(accUsage, lastResponseId));
      throw err;
    }

    segmentCount += 1;
    accUsage = sumNormalizedUsage(accUsage, seg.usage);
    if (seg.lastResponseId) lastResponseId = seg.lastResponseId;

    if (pendingSteers) {
      for (const id of pendingSteers.ids) {
        try {
          await spec.steerSource!.markDrained([id], pendingSteers.turn);
        } catch {
        }
      }
      emit({ type: "steer_drained", count: pendingSteers.count, iter: pendingSteers.turn });
      pendingSteers = null;
    }

    if (!canBargeInInRun || seg.hard || spec.abort.signal.aborted) break;
    if (segmentCount >= MAX_BARGE_IN_SEGMENTS) break;

    let steers;
    try {
      steers = await spec.steerSource!.drain(afterSeq, 10);
    } catch {
      break;
    }
    if (!steers || steers.length === 0) break;

    turn += 1;
    input = mapUserContentToInput(steers.map((s) => s.body).join("\n\n"));
    afterSeq = steers[steers.length - 1].seq;
    pendingSteers = { ids: steers.map((s) => s.id), count: steers.length, turn };
  }

  yield emit(makeTerminal(accUsage, lastResponseId));
}

export const _streamOpenAICompatRunForTests = streamOpenAICompatRun;

export class OpenAIAgentEngine implements AgentEngine {
  readonly provider = "openai" as const;

  async *run(spec: AgentEngineRunSpec): AsyncIterable<EngineEvent> {
    const client = getOpenAi();
    if (!client) {
      throw new Error(
        "OpenAIAgentEngine.run: OPENAI_API_KEY is not set — cannot run the OpenAI engine.",
      );
    }

    assertModelMatchesProvider("openai", spec.model);

    const agent = buildOpenAiAgent(spec);
    yield* streamOpenAICompatRun(spec, agent, "openai");
  }
}

const BEDROCK_DEFAULT_REGION = "us-west-2";

export const BEDROCK_MODEL_REGION: Record<string, string> = {
  "qwen.qwen3-next-80b-a3b-instruct": "us-west-2",
  "mistral.mistral-large-3-675b-instruct": "us-west-2",
  "deepseek.v3.2": "us-west-2",
  "deepseek.v3.1": "us-west-2",
  "zai.glm-5": "us-east-1",
};

export function bedrockRegionForModel(model: string): string {
  return BEDROCK_MODEL_REGION[(model ?? "").trim()] ?? BEDROCK_DEFAULT_REGION;
}

export function resolveBedrockBaseUrl(
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const region = bedrockRegionForModel(model);
  const regionKey = `BEDROCK_OPENAI_BASE_URL_${region.toUpperCase().replace(/-/g, "_")}`;
  const perRegion = env[regionKey];
  if (perRegion && perRegion.trim().length > 0) return perRegion.trim();
  const global = env.BEDROCK_OPENAI_BASE_URL;
  if (region === BEDROCK_DEFAULT_REGION && global && global.trim().length > 0) {
    return global.trim();
  }
  return `https://bedrock-mantle.${region}.api.aws/v1`;
}

export class BedrockOpenAICompatAgentEngine implements AgentEngine {
  readonly provider = "bedrock" as const;

  async *run(spec: AgentEngineRunSpec): AsyncIterable<EngineEvent> {
    const apiKey = process.env.AWS_BEARER_TOKEN_BEDROCK;
    if (!apiKey) {
      throw new Error(
        "BedrockOpenAICompatAgentEngine.run: AWS_BEARER_TOKEN_BEDROCK is not " +
          "set — cannot run the Bedrock engine. Add it to Secrets Manager " +
          "(praxis-envprod-1) and restart the container.",
      );
    }

    assertModelMatchesProvider("bedrock", spec.model);

    const baseURL = resolveBedrockBaseUrl(spec.model);

    const client = new OpenAI({ apiKey, baseURL });
    const model = new OpenAIChatCompletionsModel(client, spec.model);
    const agent = buildOpenAiAgent(spec, model);
    yield* streamOpenAICompatRun(spec, agent, "stateless");
  }
}

export class FireworksOpenAICompatAgentEngine implements AgentEngine {
  readonly provider = "fireworks" as const;

  async *run(spec: AgentEngineRunSpec): AsyncIterable<EngineEvent> {
    const apiKey = process.env.FIREWORKS_API_KEY;
    if (!apiKey) {
      throw new Error(
        "FireworksOpenAICompatAgentEngine.run: FIREWORKS_API_KEY is not " +
          "set — cannot run the Fireworks engine. Add it to Secrets Manager " +
          "(praxis-envprod-1) and restart the container.",
      );
    }

    assertModelMatchesProvider("fireworks", spec.model);

    const baseURL =
      process.env.FIREWORKS_BASE_URL || "https://api.fireworks.ai/inference/v1";

    const client = new OpenAI({ apiKey, baseURL });
    const model = new OpenAIChatCompletionsModel(client, spec.model);
    const agent = buildOpenAiAgent(
      spec,
      model,
      modelSuppressesStructuredOutput(spec.model, "fireworks"),
    );
    yield* streamOpenAICompatRun(spec, agent, "stateless");
  }
}

export class OpenRouterUnpinnedError extends Error {
  constructor(public costUsd: number) {
    super("openrouter_unpinned_route");
    this.name = "OpenRouterUnpinnedError";
  }
}

export async function* withOpenRouterCost(
  events: AsyncIterable<EngineEvent>,
  recorder: Pick<OpenRouterRunRecorder, "settle" | "verdict" | "totalCostUsd">,
): AsyncIterable<EngineEvent> {
  for await (const ev of events) {
    if (ev.type !== "terminal") {
      yield ev;
      continue;
    }
    await recorder.settle();
    const verdict = recorder.verdict();
    if (verdict === "unpinned_route") {
      const billed = recorder.totalCostUsd();
      yield { ...ev, costUsd: billed };
      throw new OpenRouterUnpinnedError(billed);
    }
    if (verdict === "no_usage_cost") {
      console.warn("[openrouter] a call returned no usage.cost; falling back to estimate");
    }
    yield verdict === "ok" ? { ...ev, costUsd: recorder.totalCostUsd() } : ev;
  }
}

export class OpenRouterOpenAICompatAgentEngine implements AgentEngine {
  readonly provider = "openrouter" as const;

  async *run(spec: AgentEngineRunSpec): AsyncIterable<EngineEvent> {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OpenRouterOpenAICompatAgentEngine.run: OPENROUTER_API_KEY is not set.",
      );
    }
    const upstream = (spec.openRouterUpstream ?? process.env.PRAXIS_SHADOW_OPENROUTER_UPSTREAM ?? "").trim();
    if (!upstream) {
      throw new Error(
        "OpenRouterOpenAICompatAgentEngine.run: PRAXIS_SHADOW_OPENROUTER_UPSTREAM " +
          "is not set. The bench refuses an unpinned OpenRouter route.",
      );
    }
    assertModelMatchesProvider("openrouter", spec.model);

    const pin: OpenRouterPin = { upstream };
    const recorder = new OpenRouterRunRecorder(pin);
    if (spec.runId && !spec.openRouterUpstream) registerOpenRouterRecorder(spec.runId, recorder);
    const client = new OpenAI({
      apiKey,
      baseURL: process.env.OPENROUTER_BASE_URL || OPENROUTER_BASE_URL,
      fetch: makeOpenRouterFetch(pin, recorder),
    });
    const base = new OpenAIChatCompletionsModel(client, spec.model);
    const model: Model = spec.onAssistantTurn ? new TurnHookModel(base, spec.onAssistantTurn) : base;
    const agent = buildOpenAiAgent(
      spec,
      model,
      modelSuppressesStructuredOutput(spec.model, "openrouter"),
    );
    const events = streamOpenAICompatRun(spec, agent, "stateless");
    yield* spec.openRouterUpstream ? withOpenRouterCost(events, recorder) : events;
  }
}

export class CodexSubscriptionAgentEngine implements AgentEngine {
  readonly provider = "codex" as const;

  async *run(spec: AgentEngineRunSpec): AsyncIterable<EngineEvent> {
    const client = getCodexClient();
    if (!client) {
      throw new Error(
        "CodexSubscriptionAgentEngine.run: CODEX_ACCESS_TOKEN is not set — " +
          "cannot run the codex-subscription engine. Add CODEX_ACCESS_TOKEN + " +
          "CODEX_ACCOUNT_ID to Secrets Manager (praxis-envprod-1) and restart.",
      );
    }

    assertModelMatchesProvider("codex", spec.model);

    const model = new OpenAIResponsesModel(client, spec.model);
    const agent = buildOpenAiAgent(spec, model);
    agent.modelSettings = { ...agent.modelSettings, store: false };
    yield* streamOpenAICompatRun(spec, agent, "stateless");
  }
}

function openAiUsageToRaw(u: Record<string, unknown>): Record<string, unknown> {
  const inputTokens = numOr0(u.inputTokens);
  const outputTokens = numOr0(u.outputTokens);
  const cached = sumCachedTokens(u.inputTokensDetails);
  return {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    prompt_tokens_details: { cached_tokens: cached },
  };
}

function sumCachedTokens(details: unknown): number {
  if (!details) return 0;
  const pull = (o: unknown): number => {
    if (o && typeof o === "object") {
      const v = (o as Record<string, unknown>).cached_tokens;
      return numOr0(v);
    }
    return 0;
  };
  if (Array.isArray(details)) {
    return details.reduce((sum: number, d) => sum + pull(d), 0);
  }
  return pull(details);
}

function numOr0(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

function finalUsageFromStream(
  streamed: { state?: { usage?: unknown } },
  lastRawUsage: Record<string, unknown> | undefined,
) {
  const runUsage = streamed.state?.usage;
  if (runUsage && typeof runUsage === "object") {
    return normalizeUsage(
      openAiUsageToRaw(runUsage as Record<string, unknown>),
      "openai",
    );
  }
  if (lastRawUsage) return normalizeUsage(lastRawUsage, "openai");
  return normalizeUsage(undefined, "openai");
}

function isAbortError(err: unknown, spec: AgentEngineRunSpec): boolean {
  if (spec.abort.signal.aborted) return true;
  if (err && typeof err === "object") {
    const name = (err as { name?: string }).name;
    if (name === "AbortError") return true;
  }
  return false;
}
