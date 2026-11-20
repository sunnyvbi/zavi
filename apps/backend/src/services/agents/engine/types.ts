
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import type { NormalizedUsage } from "@/services/llm/normalize-usage";
import type { Provider } from "@/services/llm/models";
import type { ToolSearchHints } from "./tool-search";

export type { Provider } from "@/services/llm/models";
export type { NormalizedUsage } from "@/services/llm/normalize-usage";

export type UserContent = MessageParam["content"];

export interface EngineToolSpec {
  name: string;
  description: string;
  jsonSchema: unknown;
}

export interface EngineToolCall {
  tool_name: string;
  server_id?: string;
  bare_tool_name?: string;
  input: unknown;
  tool_use_id: string;
}

export interface EngineToolResult {
  is_error: boolean;
  content: string;
  ms: number;
  code?: string;
  denied?: boolean;
}

export type EngineResumeHandle =
  | { kind: "sdk_session"; sessionId: string }
  | { kind: "openai"; threadId?: string; lastResponseId?: string };

export type EngineEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; name: string; ms: number; code: string; iter: number }
  | { type: "usage"; usage: NormalizedUsage }
  | {
      type: "assistant_text";
      text: string;
      isFirstTextBlock: boolean;
      iter: number;
    }
  | { type: "assistant_turn"; hadContent: boolean; iter: number }
  | { type: "tool_use"; name: string; input: unknown; tool_use_id: string; iter: number }
  | {
      type: "tool_result";
      tool_use_id: string;
      name: string;
      content: unknown;
      isError: boolean;
      ms: number;
      iter: number;
    }
  | { type: "tool_start"; name: string; input: unknown }
  | { type: "reasoning"; text: string; iter: number }
  | { type: "steer_drained"; count: number; iter: number }
  | {
      type: "terminal";
      resume: EngineResumeHandle | null;
      usage: NormalizedUsage;
      costUsd?: number;
      authSeat?: string;
      stopReason?: string;
      structuredOutput?: unknown;
    };

export type OperatorTierPreCheck = (
  call: EngineToolCall,
) =>
  | { allow: true }
  | { allow: false; reason: string; synthetic_tool_result: string };

export interface SteerMsg {
  id: string;
  seq: number;
  body: string;
  origin: "chat" | "slack" | "email" | "teams";
  author_user_id: string | null;
}

export interface SteerSource {
  drain(afterSeq: number, max: number): Promise<SteerMsg[]>;
  markDrained(ids: string[], turn: number): Promise<void>;
}

export interface AgentEngineRunSpec {
  promptCacheTtl?: "1h" | "5m";
  systemPrompt: string;
  userPrompt: UserContent;
  model: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  maxTurns: number;
  tools: EngineToolSpec[];
  resume: EngineResumeHandle | null;
  abort: AbortController;
  dispatchTool: (call: EngineToolCall) => Promise<EngineToolResult>;
  onEvent: (e: EngineEvent) => void;
  outputJsonSchema?: { type: "json_schema"; schema: Record<string, unknown> };
  runId?: string;
  tenantId?: string;
  threadId?: string | null;
  steerSource?: SteerSource;
  toolSearch?: ToolSearchHints;
  openRouterUpstream?: string;
  onAssistantTurn?: (t: { text: string; turn: number; hasToolCalls: boolean }) => void | Promise<void>;
}

export interface AgentEngine {
  provider: Provider;
  run(spec: AgentEngineRunSpec): AsyncIterable<EngineEvent>;
}
