
import {
  OpenAIAgentEngine,
  BedrockOpenAICompatAgentEngine,
  FireworksOpenAICompatAgentEngine,
} from "@/services/agents/engine/openai-engine";
import type {
  AgentEngine,
  AgentEngineRunSpec,
  EngineEvent,
  EngineToolResult,
} from "@/services/agents/engine/types";
import { callModel as defaultCallModel, type CallModelResult } from "@/services/llm/call-model";
import { MODELS } from "@/services/llm/models";
import { normalizeUsage, type NormalizedUsage } from "@/services/llm/normalize-usage";
import { toOutputFormatJsonSchema, AGENT_OUTPUT_CLASS } from "@/services/agents/structured-output";
import type { Provider } from "@/services/llm/models";
import type { EngineRunCapture, ParityTask } from "./engine-parity";

const OPENAI_MODEL = process.env.PRAXIS_PARITY_OPENAI_MODEL || MODELS.openai.flagship;
const BEDROCK_MODEL = process.env.PRAXIS_PARITY_BEDROCK_MODEL || MODELS.bedrock.qwen3Next80b;
const FIREWORKS_MODEL =
  process.env.PRAXIS_PARITY_FIREWORKS_MODEL || MODELS.fireworks.glm52;
const ANTHROPIC_MODEL = process.env.PRAXIS_PARITY_ANTHROPIC_MODEL || MODELS.anthropic.opus;
const MAX_TURNS = 3;
const ANTHROPIC_MAX_TOKENS = 700;

export type LiveRunnerDeps = {
  engineFactory?: () => AgentEngine;
  callModelFn?: typeof defaultCallModel;
  now?: () => number;
};

function structuredSchemaForTask(
  task: ParityTask,
): { type: "json_schema"; schema: Record<string, unknown> } | null {
  if (!AGENT_OUTPUT_CLASS[task.agent_slug]) return null;
  try {
    return toOutputFormatJsonSchema(task.agent_slug);
  } catch {
    return null;
  }
}

export async function runTaskThroughEngine(
  task: ParityTask,
  provider: Provider,
  deps: LiveRunnerDeps = {},
): Promise<EngineRunCapture> {
  if (provider === "openai")
    return runEngineLane(task, deps, () => new OpenAIAgentEngine(), OPENAI_MODEL);
  if (provider === "bedrock")
    return runEngineLane(
      task,
      deps,
      () => new BedrockOpenAICompatAgentEngine(),
      BEDROCK_MODEL,
    );
  if (provider === "fireworks")
    return runEngineLane(
      task,
      deps,
      () => new FireworksOpenAICompatAgentEngine(),
      FIREWORKS_MODEL,
    );
  return runAnthropicLane(task, deps);
}

async function runEngineLane(
  task: ParityTask,
  deps: LiveRunnerDeps,
  makeDefaultEngine: () => AgentEngine,
  model: string,
): Promise<EngineRunCapture> {
  const now = deps.now ?? Date.now;
  const engine = (deps.engineFactory ?? makeDefaultEngine)();
  const outputJsonSchema = structuredSchemaForTask(task);

  let toolCalls = 0;
  const dispatchTool = async (): Promise<EngineToolResult> => {
    toolCalls += 1;
    return { is_error: false, content: "", ms: 0 };
  };

  const events: EngineEvent[] = [];
  const spec: AgentEngineRunSpec = {
    systemPrompt: task.system,
    userPrompt: task.prompt,
    model,
    maxTurns: MAX_TURNS,
    tools: [],
    resume: null,
    abort: new AbortController(),
    dispatchTool,
    onEvent: (e) => events.push(e),
    ...(outputJsonSchema ? { outputJsonSchema } : {}),
  };

  const t0 = now();
  let errored = false;
  let errorDetail: string | undefined;
  try {
    for await (const _ of engine.run(spec)) void _;
  } catch (e) {
    errored = true;
    errorDetail = (e as Error)?.name || "Error";
  }
  const latency_ms = now() - t0;

  const output = events
    .filter((e): e is Extract<EngineEvent, { type: "text_delta" }> => e.type === "text_delta")
    .map((e) => e.text)
    .join("");

  const usage = usageFromEvents(events);

  return {
    output,
    latency_ms,
    usage,
    model,
    gated_tool_calls: Math.max(toolCalls, countToolCallEvents(events)),
    errored,
    ...(errorDetail ? { error_detail: errorDetail } : {}),
  };
}

function usageFromEvents(events: EngineEvent[]): NormalizedUsage {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "terminal") return e.usage;
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "usage") return e.usage;
  }
  return normalizeUsage(undefined, "openai");
}

function countToolCallEvents(events: EngineEvent[]): number {
  return events.filter((e) => e.type === "tool_call").length;
}

async function runAnthropicLane(
  task: ParityTask,
  deps: LiveRunnerDeps,
): Promise<EngineRunCapture> {
  const now = deps.now ?? Date.now;
  const call = deps.callModelFn ?? defaultCallModel;
  const outputJsonSchema = structuredSchemaForTask(task);

  const system = outputJsonSchema
    ? `${task.system}\n\nRespond ONLY with a single JSON object that conforms to this JSON Schema (no prose, no code fence):\n${JSON.stringify(outputJsonSchema.schema)}`
    : task.system;

  const t0 = now();
  let res: CallModelResult;
  try {
    res = await call({
      provider: "anthropic",
      model: ANTHROPIC_MODEL,
      system,
      messages: [{ role: "user", content: task.prompt }],
      max_tokens: ANTHROPIC_MAX_TOKENS,
    });
  } catch (e) {
    return {
      output: "",
      latency_ms: now() - t0,
      usage: normalizeUsage(undefined, "anthropic"),
      model: ANTHROPIC_MODEL,
      gated_tool_calls: 0,
      errored: true,
      error_detail: (e as Error)?.name || "Error",
    };
  }

  return {
    output: res.text,
    latency_ms: now() - t0,
    usage: res.usage,
    model: ANTHROPIC_MODEL,
    gated_tool_calls: 0,
    errored: false,
  };
}

export function makeLiveRunTask(
  deps: LiveRunnerDeps = {},
): (task: ParityTask, provider: Provider) => Promise<EngineRunCapture> {
  return (task, provider) => runTaskThroughEngine(task, provider, deps);
}
