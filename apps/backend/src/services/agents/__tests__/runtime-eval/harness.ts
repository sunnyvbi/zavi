
import { vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlock,
  ToolUseBlock,
  TextBlock,
} from "@anthropic-ai/sdk/resources/messages";
import type { AgentContext, AgentDefinition, AgentMetadata } from "../../types";
import type { DispatcherResult } from "../../types";

export type StubModelTurn = {
  text?: string;
  toolUses?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  stopReason?: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
  usage?: { input_tokens: number; output_tokens: number };
};

function turnToMessage(turn: StubModelTurn): Anthropic.Messages.Message {
  const content: ContentBlock[] = [];
  if (turn.text && turn.text.length > 0) {
    content.push({ type: "text", text: turn.text, citations: null } as TextBlock);
  }
  for (const tu of turn.toolUses ?? []) {
    content.push({
      type: "tool_use",
      id: tu.id,
      name: tu.name,
      input: tu.input,
    } as ToolUseBlock);
  }
  const stop_reason =
    turn.stopReason ?? ((turn.toolUses?.length ?? 0) > 0 ? "tool_use" : "end_turn");
  return {
    id: `msg_stub_${Math.random().toString(36).slice(2)}`,
    type: "message",
    role: "assistant",
    model: "stub-model",
    content,
    stop_reason,
    stop_sequence: null,
    usage: {
      input_tokens: turn.usage?.input_tokens ?? 100,
      output_tokens: turn.usage?.output_tokens ?? 50,
    },
  } as unknown as Anthropic.Messages.Message;
}

export function makeStubAnthropic(turns: StubModelTurn[]): {
  client: Anthropic;
  createCalls: () => number;
} {
  const queue = [...turns];
  let calls = 0;
  const create = vi.fn(async () => {
    calls += 1;
    const next = queue.shift();
    if (!next) {
      throw new Error(
        `[runtime-eval] stub Anthropic ran out of scripted turns after ${calls} call(s) — the dispatcher requested more model turns than the golden provided. Add a terminal (end_turn) turn or fewer tool_uses.`,
      );
    }
    return turnToMessage(next);
  });
  const client = {
    messages: { create },
  } as unknown as Anthropic;
  return { client, createCalls: () => calls };
}

export type StubToolResult = { is_error: boolean; content: string; ms?: number };

let toolResultMap: Record<string, StubToolResult> = {};
export function setStubToolResults(map: Record<string, StubToolResult>): void {
  toolResultMap = map;
}
export function getStubToolResult(name: string): StubToolResult {
  return (
    toolResultMap[name] ?? {
      is_error: false,
      content: JSON.stringify({ ok: true }),
      ms: 1,
    }
  );
}

let discoveryTools: string[] = [];
export function setStubDiscoveryTools(names: string[]): void {
  discoveryTools = names;
}

const DEFAULT_METADATA: AgentMetadata = {
  model: "stub-model",
  manual_only: true,
  chat_eligible: true,
  side_effects: false,
  cost_class: "standard",
  kill_switch: true,
  impact_classes: [],
  cron: "",
  triggers: [],
  runtime: "subprocess",
  department: "others",
  tools: [],
  prose_fallback: false,
  response_contract: "auto",
  chat_thought_partner_mode: false,
  tool_iter_cap: undefined,
  requires_sandbox: false,
  memory_layer: false,
  recall_policy: "live_state_aware",
  inherits: [],
  visibility: { default_state: "enabled" },
  capabilities: {
    money_path: false,
    reads_operator_db: false,
    emits_artifact: false,
    structured_clarifications: false,
  },
};

export function makeAgent(
  slug: string,
  overrides: Partial<AgentMetadata> & { body_markdown?: string } = {},
): AgentDefinition {
  const { body_markdown, ...metaOverrides } = overrides;
  return {
    slug,
    name: slug,
    description: `runtime-eval stub agent ${slug}`,
    body_markdown:
      body_markdown ??
      "You are a test agent. Follow your spec and emit your output.",
    body_path: `src/agents/${slug}/agent.md`,
    content_hash: "stub-hash",
    metadata_praxis: { ...DEFAULT_METADATA, ...metaOverrides },
  };
}

export type CtxOverrides = {
  trigger?: AgentContext["trigger"];
  thread_id?: string;
  userId?: string;
};

export function makeCtx(
  agent: AgentDefinition,
  anthropic: Anthropic,
  overrides: CtxOverrides = {},
): {
  ctx: AgentContext;
  emittedDecisions: Array<{ decision_class: string; body: unknown }>;
  progressEvents: Array<{ stage: string; meta?: Record<string, unknown> }>;
} {
  const emittedDecisions: Array<{ decision_class: string; body: unknown }> = [];
  const progressEvents: Array<{ stage: string; meta?: Record<string, unknown> }> = [];
  const ctx: AgentContext = {
    agent,
    tenant_id: "00000000-0000-0000-0000-000000000000",
    tenantConfig: {
      tenant_id: "00000000-0000-0000-0000-000000000000",
      slug: "test-tenant",
      display_name: "Test Tenant",
      gmv_thresholds: { RaR_weekly: 0 },
      channel_ids: {},
      timezone: "America/Los_Angeles",
    },
    memory: {
      company: "",
      ops: "",
      policies: "",
      disputes: "",
      support: "",
    },
    episodic: "",
    anthropic,
    runId: "11111111-1111-1111-1111-111111111111",
    trigger: overrides.trigger ?? "manual",
    thread_id: overrides.thread_id,
    userId: overrides.userId,
    scanRecentRuns: async () => [],
    emitDecision: async (decision_class, body) => {
      emittedDecisions.push({ decision_class, body });
      return `decision_${emittedDecisions.length}`;
    },
    emitProgress: async (stage, meta) => {
      progressEvents.push({ stage, meta: meta as Record<string, unknown> });
    },
    citedNotes: new Map(),
  };
  return { ctx, emittedDecisions, progressEvents };
}

export function registerRuntimeEvalMocks(): void {
  vi.mock("@/services/supabase", () => ({
    serviceClient: () => makeNoopSupabase(),
  }));
  vi.mock("@/services/mcp/discovery", () => {
    const buildTools = () =>
      discoveryTools.map((anthropicName) => {
        const idx = anthropicName.indexOf("__");
        const server_id = anthropicName.slice(0, idx);
        const tool_name = anthropicName.slice(idx + 2);
        return {
          name: anthropicName,
          description: `stub tool ${anthropicName}`,
          input_schema: { type: "object", properties: {} },
          server_id,
          tool_name,
        };
      });
    return {
      discoverToolsForTenant: async () => ({
        tools: buildTools(),
        disconnected_connectors: [],
      }),
      listToolsForTenant: async () => buildTools(),
      _clearToolCacheForTests: () => {},
    };
  });
  vi.mock("@/services/mcp/execute", () => ({
    callMcpTool: async (
      _bind: unknown,
      server_id: string,
      tool_name: string,
    ) => {
      const r = getStubToolResult(`${server_id}__${tool_name}`);
      return { is_error: r.is_error, content: r.content, ms: r.ms ?? 1 };
    },
  }));
  vi.mock("@/services/memory", () => ({
    searchMemory: async () => [],
    loadRecentFeedbackForAgent: async () => [],
    loadTenantEntityHints: async () => [],
    loadEntityContext: async () => [],
  }));
  vi.mock("@/services/memory/extract", () => ({
    extractEntitiesWithHints: () => ({ entities: [] }),
  }));
  vi.mock("@/services/memory/write-signal", () => ({
    writeOperatorStep: async () => {},
    readOperatorStepScratchpad: async () => [],
  }));
  vi.mock("../../thread-event", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../thread-event")>();
    return {
      ...actual,
      emitThreadEvent: async () => {},
      emitThreadEventOnce: async () => {},
    };
  });
  vi.mock("../../learnings", () => ({
    loadAgentLearnings: async () => [],
  }));
  vi.mock("../../setup-schema", () => ({
    probeSetupCompleteness: async () => ({
      ok: true,
      missing_vault_keys: [],
      missing_connectors: [],
      missing_required_connectors: [],
      missing_optional_connectors: [],
    }),
    getAgentSetupSchema: async () => null,
    recordSetupBlock: async () => {},
  }));
}

function makeNoopSupabase(): unknown {
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  for (const m of [
    "from",
    "select",
    "eq",
    "neq",
    "gt",
    "not",
    "order",
    "limit",
    "update",
    "insert",
  ]) {
    builder[m] = chain;
  }
  builder.maybeSingle = async () => ({ data: null, error: null });
  builder.single = async () => ({ data: null, error: null });
  builder.rpc = async () => ({ data: null, error: null });
  builder.then = (resolve: (v: unknown) => void) =>
    resolve({ data: null, error: null });
  return builder;
}

export type Golden = {
  name: string;
  agentSlug: string;
  metadata?: Partial<AgentMetadata> & { body_markdown?: string };
  trigger?: AgentContext["trigger"];
  thread_id?: string;
  declaredTools?: string[];
  toolResults?: Record<string, StubToolResult>;
  modelTurns: StubModelTurn[];
};

export async function driveGolden(
  runGeneric: (ctx: AgentContext, payload?: unknown) => Promise<DispatcherResult>,
  golden: Golden,
  payload: unknown,
): Promise<{
  result: DispatcherResult;
  emittedDecisions: Array<{ decision_class: string; body: unknown }>;
  progressEvents: Array<{ stage: string; meta?: Record<string, unknown> }>;
  modelCalls: number;
}> {
  setStubDiscoveryTools(golden.declaredTools ?? []);
  setStubToolResults(golden.toolResults ?? {});
  const agent = makeAgent(golden.agentSlug, {
    ...(golden.metadata ?? {}),
    tools: golden.declaredTools ?? golden.metadata?.tools ?? [],
  });
  const { client, createCalls } = makeStubAnthropic(golden.modelTurns);
  const { ctx, emittedDecisions, progressEvents } = makeCtx(agent, client, {
    trigger: golden.trigger,
    thread_id: golden.thread_id,
  });
  const result = await runGeneric(ctx, payload);
  return {
    result,
    emittedDecisions,
    progressEvents,
    modelCalls: createCalls(),
  };
}
