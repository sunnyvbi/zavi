
import { query } from "@anthropic-ai/claude-agent-sdk";
import { buildAgentChildEnv } from "@/services/agents/agent-auth";
import { withAgentSdkIsolation } from "@/services/agents/sdk-isolation";
import {
  buildSystemPromptForTest,
  resolveClaudeBinary,
} from "@/services/agents/generic-dispatcher";
import { loadAgentDefinition } from "@/services/agents/registry";
import { SDK_DISALLOWED_BUILTINS } from "@/services/agents/sdk-builtins";
import { MODELS } from "@/services/llm/models";
import type { CgoModelCall } from "./cgo-adapter";
import type { ReplayToolCall, ReplayWorld } from "./decision-replay";

export const CGO_REVIEW_MODEL = MODELS.anthropic.opus;

export const PROD_MAX_TOOL_ITERS = 60;

export type CgoProdConfig = { model: string; tools: string[]; maxTurns: number; body: string };

let prodConfig: Promise<CgoProdConfig> | null = null;

export function cgoProdConfig(): Promise<CgoProdConfig> {
  prodConfig ??= (async () => {
    const def = await loadAgentDefinition("cgo");
    if (!def) throw new Error("cgo eval: cgo agent definition not found");
    const m = def.metadata_praxis;
    return {
      model: m.model,
      tools: [...(m.tools ?? [])],
      maxTurns: m.tool_iter_cap ?? PROD_MAX_TOOL_ITERS,
      body: def.body_markdown,
    };
  })();
  return prodConfig;
}

export const DISALLOWED_BUILTIN_TOOLS = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "Grep",
  "Glob",
  "Task",
  "WebFetch",
  "WebSearch",
  "NotebookEdit",
  "TodoWrite",
  "KillShell",
  "BashOutput",
  "SlashCommand",
  "ToolSearch",
];

export async function cgoSystemPrompt(company: string): Promise<string> {
  const { body } = await cgoProdConfig();
  return buildSystemPromptForTest({
    body_markdown: body,
    memory: { company, ops: "" },
    run_context: {},
  });
}

export type LiveAuth = { mode: "oauth" | "api_key"; secret: string };

function childEnv(auth: LiveAuth) {
  return buildAgentChildEnv({
    mode: auth.mode,
    ...(auth.mode === "oauth" ? { oauthToken: auth.secret } : { apiKey: auth.secret }),
    baseEnv: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
    },
  });
}

export function liveAuth(env: NodeJS.ProcessEnv = process.env): LiveAuth {
  const oauth = env.CLAUDE_CODE_OAUTH_TOKEN?.split(",")[0]?.trim();
  if (oauth) return { mode: "oauth", secret: oauth };
  const key = env.ANTHROPIC_API_KEY?.trim();
  if (key) return { mode: "api_key", secret: key };
  throw new Error("cgo eval: set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY (apps/backend/.env)");
}

export function cgoQueryOptions(
  systemPrompt: string,
  token: string,
  onStderr: (d: string) => void,
  model?: string,
) {
  const binary = resolveClaudeBinary();
  return withAgentSdkIsolation({
    systemPrompt,
    model: model ?? CGO_REVIEW_MODEL,
    maxTurns: 1,
    allowedTools: [],
    disallowedTools: DISALLOWED_BUILTIN_TOOLS,
    settingSources: [],
    env: childEnv({ mode: "oauth", secret: token }),
    ...(binary ? { pathToClaudeCodeExecutable: binary } : {}),
    stderr: onStderr,
  });
}

export const liveCgoModel: CgoModelCall = async (systemPrompt, userPrompt) => {
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!token)
    throw new Error(
      "growth-sim: CLAUDE_CODE_OAUTH_TOKEN is not set (run with --env-file=.env)",
    );
  const { model } = await cgoProdConfig();
  let text = "";
  let resultText = "";
  let tokens = 0;
  let stderr = "";
  const stream = query({
    prompt: userPrompt,
    options: cgoQueryOptions(systemPrompt, token, (d) => {
      stderr = (stderr + d).slice(-2000);
    }, model),
  });
  try {
    for await (const msg of stream) {
      const m = msg as {
        type?: string;
        subtype?: string;
        is_error?: boolean;
        result?: string;
        message?: { content?: unknown };
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      if (m.type === "assistant" && Array.isArray(m.message?.content)) {
        for (const b of m.message.content as Array<{
          type?: string;
          text?: string;
          name?: string;
        }>) {
          if (b.type === "text" && b.text) text += b.text;
          if (b.type === "tool_use")
            throw new Error(
              `cgo tried to call tool ${b.name ?? "?"} with tools off`,
            );
        }
      }
      if (m.type === "result") {
        if (m.subtype !== "success" || m.is_error)
          throw new Error(
            `result ${m.subtype ?? "?"}${m.is_error ? " (is_error)" : ""}${m.result ? `: ${m.result.slice(0, 300)}` : ""}`,
          );
        resultText = m.result ?? "";
        if (m.usage)
          tokens = (m.usage.input_tokens ?? 0) + (m.usage.output_tokens ?? 0);
      }
    }
  } catch (e) {
    throw new Error(
      `cgo model call failed: ${(e as Error).message}${stderr ? ` | ${stderr.trim()}` : ""}`,
    );
  }
  return { text: text || resultText, tokens };
};

export const REPLAY_MCP_SERVER = "server";

const NOTHING_HERE = "Nothing to read in this replay. Decide from memory.cgo_goals in the run context (its goals, channels, open_cards and evidence).";

export function replayToolAnswer(name: string, input: Record<string, unknown>, world: ReplayWorld): string {
  if (name === "growth__read_business_controls") return JSON.stringify({policy:null,experiments:[],note:"These legacy replay fixtures have no saved business controls."});
  if (name === "meta_ads__list_campaigns") {
    const rows = (world.campaigns ?? [])
      .filter((c) => c.platform === "meta")
      .map((c) => ({ id: c.id, name: c.name, objective: c.objective, status: c.pausedByFounder === undefined ? "ACTIVE" : "PAUSED" }));
    return JSON.stringify({ campaigns: rows });
  }
  if (name === "meta_ads__list_ad_sets") {
    const want = typeof input.campaign_id === "string" ? input.campaign_id : null;
    const rows = (world.campaigns ?? [])
      .filter((c) => c.platform === "meta" && (!want || c.id === want))
      .flatMap((c) =>
        c.sets.map((s) => ({
          id: s.facts.id,
          name: s.name,
          campaign_id: c.id,
          optimization_goal: s.facts.objective,
          learning: s.facts.learning,
          spend_7d_usd: s.facts.spend7dUsd,
          conversions_7d: s.facts.conversions7d,
          status: c.pausedByFounder === undefined ? "ACTIVE" : "PAUSED",
        })),
      );
    return JSON.stringify({ ad_sets: rows });
  }
  if (/__propose_/.test(name)) return "Recorded. The server decides this change after the review; nothing was applied yet.";
  if (name === "memory__write") return "Recorded.";
  return NOTHING_HERE;
}

async function declaredToolDefs(declared: string[]) {
  const [{ listMemoryToolsForFlag }, { listGrowthTools }, { listMetaAdsTools }, { listWebSearchTools }] = await Promise.all([
    import("@/services/mcp/internal/memory"),
    import("@/services/mcp/internal/growth"),
    import("@/services/mcp/internal/meta-ads"),
    import("@/services/mcp/internal/web-search"),
  ]);
  const known = [...listMemoryToolsForFlag(true), ...listGrowthTools(), ...listMetaAdsTools(), ...listWebSearchTools()];
  return declared.map((name) => {
    const t = known.find((k) => `${k.server_id}__${k.tool_name}` === name);
    return {
      name,
      description: t?.description ?? `${name} (not available in this replay).`,
      input_schema: t?.input_schema ?? { type: "object" as const, properties: {} },
    };
  });
}

export type ReplayModelResult = { text: string; toolCalls: ReplayToolCall[]; tokens: number; costUsd: number; turns: number };

export async function liveReplayCall(systemPrompt: string, userPrompt: string, world: ReplayWorld): Promise<ReplayModelResult> {
  const cfg = await cgoProdConfig();
  const auth = liveAuth();
  const { createSdkMcpServer, tool } = await import("@anthropic-ai/claude-agent-sdk");
  const { buildToolInputShape, sdkToolDescription, unwrapToolArgs } = await import("@/services/agents/sdk/tool-input-shape");
  const calls: ReplayToolCall[] = [];
  const defs = await declaredToolDefs(cfg.tools);
  const tools = defs.map((d) => {
    const { shape, declaresOwnInput } = buildToolInputShape(d.input_schema);
    return tool(
      d.name,
      sdkToolDescription(d.description, d.input_schema),
      shape as never,
      (async (args: unknown) => {
        const input = (unwrapToolArgs(args, declaresOwnInput) ?? {}) as Record<string, unknown>;
        calls.push({ name: d.name, input });
        return { content: [{ type: "text" as const, text: replayToolAnswer(d.name, input, world) }] };
      }) as never,
    );
  });
  const server = createSdkMcpServer({ name: "praxis-server", version: "0.1.0", tools: tools as unknown as Parameters<typeof createSdkMcpServer>[0]["tools"] });
  const binary = resolveClaudeBinary();
  let text = "";
  let resultText = "";
  let tokens = 0;
  let costUsd = 0;
  let turns = 0;
  let stderr = "";
  const stream = query({
    prompt: userPrompt,
    options: withAgentSdkIsolation({
      systemPrompt,
      model: cfg.model,
      maxTurns: cfg.maxTurns,
      mcpServers: { [REPLAY_MCP_SERVER]: server },
      disallowedTools: [...SDK_DISALLOWED_BUILTINS],
      settingSources: [],
      env: childEnv(auth) as { [k: string]: string | undefined },
      ...(binary ? { pathToClaudeCodeExecutable: binary } : {}),
      canUseTool: async (_name: string, input: Record<string, unknown>) => ({ behavior: "allow" as const, updatedInput: input }),
      stderr: (d: string) => {
        stderr = (stderr + d).slice(-2000);
      },
    }),
  });
  try {
    for await (const msg of stream) {
      const m = msg as {
        type?: string;
        subtype?: string;
        is_error?: boolean;
        result?: string;
        num_turns?: number;
        total_cost_usd?: number;
        message?: { content?: unknown };
        usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
      };
      if (m.type === "assistant" && Array.isArray(m.message?.content)) {
        const parts = (m.message.content as Array<{ type?: string; text?: string }>).filter((b) => b.type === "text" && b.text).map((b) => b.text as string);
        if (parts.length) text = parts.join("");
      }
      if (m.type === "result") {
        if (m.subtype !== "success" || m.is_error)
          throw new Error(`result ${m.subtype ?? "?"}${m.is_error ? " (is_error)" : ""}${m.result ? `: ${m.result.slice(0, 300)}` : ""}`);
        resultText = m.result ?? "";
        costUsd = m.total_cost_usd ?? 0;
        turns = m.num_turns ?? 0;
        const u = m.usage ?? {};
        tokens = (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      }
    }
  } catch (e) {
    throw new Error(`cgo replay call failed: ${(e as Error).message}${stderr ? ` | ${stderr.trim()}` : ""}`);
  }
  return { text: resultText || text, toolCalls: calls, tokens, costUsd, turns };
}
