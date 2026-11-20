
import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { estimateCostUsd, PRICING } from "@/services/anthropic";
import { buildAgentChildEnv, resolveOAuthTokenPool } from "@/services/agents/agent-auth";
import { SDK_DISALLOWED_BUILTINS } from "@/services/agents/sdk-builtins";
import { withAgentSdkIsolation } from "@/services/agents/sdk-isolation";

const ARGS = process.argv.slice(2);
const FORCE_5M = ARGS.includes("--force-5m");
const MODEL_ARGS = ARGS.filter((a) => !a.startsWith("--"));
const MODELS = MODEL_ARGS.length ? MODEL_ARGS : ["claude-opus-4-7", "claude-opus-5-5", "claude-sonnet-5"];
const TOLERANCE = 0.02;

const DISALLOWED = [...SDK_DISALLOWED_BUILTINS];

type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
};

type ProbeResult = {
  subtype?: string;
  total_cost_usd?: number;
  stop_reason?: string | null;
  modelUsage?: Record<string, ModelUsage>;
  result?: string;
  usage?: {
    cache_creation_input_tokens?: number;
    cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number } | null;
  };
};

async function probe(model: string) {
  const server = createSdkMcpServer({
    name: "probe",
    version: "1.0.0",
    tools: [
      tool("get_number", "Returns the secret number.", { _u: z.string().optional() }, async () => ({
        content: [{ type: "text", text: "4242" }],
      })),
    ],
  });
  const token = resolveOAuthTokenPool()[0];
  const env = buildAgentChildEnv({
    mode: token ? "oauth" : "api_key",
    oauthToken: token,
    apiKey: process.env.ANTHROPIC_API_KEY,
  });
  if (FORCE_5M) {
    env.ENABLE_PROMPT_CACHING_1H = "0";
    env.FORCE_PROMPT_CACHING_5M = "1";
  }
  let init: { tools?: string[]; mcp_servers?: Array<{ name: string; status: string }> } = {};
  let result: ProbeResult | null = null;
  let toolCalled = false;
  for await (const m of query({
    prompt: "Call the get_number tool once, then reply with just the number.",
    options: withAgentSdkIsolation({
      model,
      env,
      mcpServers: { probe: server },
      disallowedTools: DISALLOWED,
      maxTurns: 4,
      ...(model === "claude-opus-5-5" ? { effort: "high" as const } : {}),
      canUseTool: async (_n: string, input: Record<string, unknown>) => ({
        behavior: "allow" as const,
        updatedInput: input,
      }),
    }),
  })) {
    const msg = m as { type: string; subtype?: string };
    if (msg.type === "system" && msg.subtype === "init") init = m as typeof init;
    if (msg.type === "assistant") {
      const content = (m as { message?: { content?: Array<{ type: string; name?: string }> } })
        .message?.content ?? [];
      if (content.some((b) => b.type === "tool_use" && b.name?.endsWith("get_number"))) toolCalled = true;
    }
    if (msg.type === "result") result = m as unknown as ProbeResult;
  }
  return { init, result: result as ProbeResult | null, toolCalled };
}

async function main() {
  let failed = false;
  for (const model of MODELS) {
    if (!PRICING[model]) {
      console.log(`${model}: NOT IN PRICING`);
      failed = true;
      continue;
    }
    let r;
    try {
      r = await probe(model);
    } catch (e) {
      console.log(`${model}: QUERY FAILED ${(e as Error).message}`);
      failed = true;
      continue;
    }
    const builtins = (r.init.tools ?? []).filter((t) => !t.startsWith("mcp__"));
    console.log(`\n== ${model} ==`);
    console.log(`subtype=${r.result?.subtype} stop_reason=${r.result?.stop_reason ?? "?"} tool_called=${r.toolCalled} reply=${JSON.stringify((r.result?.result ?? "").slice(0, 40))}`);
    console.log(`mcp_servers=${JSON.stringify(r.init.mcp_servers ?? [])}`);
    console.log(`builtin_tools_after_disallow=${JSON.stringify(builtins)}`);
    const totalWrites = r.result?.usage?.cache_creation_input_tokens ?? 0;
    const share1h =
      totalWrites > 0 ? (r.result?.usage?.cache_creation?.ephemeral_1h_input_tokens ?? 0) / totalWrites : 0;
    console.log(`cache_write_split: 1h=${(share1h * 100).toFixed(1)}% of ${totalWrites}`);
    let sumEst = 0;
    for (const [m, u] of Object.entries(r.result?.modelUsage ?? {})) {
      const w1h = Math.round(u.cacheCreationInputTokens * share1h);
      const est = estimateCostUsd(
        m,
        {
          input_tokens: u.inputTokens,
          output_tokens: u.outputTokens,
          cache_read_input_tokens: u.cacheReadInputTokens,
          cache_creation_input_tokens: u.cacheCreationInputTokens,
          cache_creation: {
            ephemeral_1h_input_tokens: w1h,
            ephemeral_5m_input_tokens: u.cacheCreationInputTokens - w1h,
          },
        },
        { onUnpriced: "throw" },
      );
      sumEst += est;
      const diff = u.costUSD > 0 ? Math.abs(est - u.costUSD) / u.costUSD : est > 0 ? 1 : 0;
      const bad = diff > TOLERANCE && Math.abs(est - u.costUSD) > 0.0002;
      if (bad) failed = true;
      console.log(
        `  ${m}: in=${u.inputTokens} out=${u.outputTokens} cache_read=${u.cacheReadInputTokens} ` +
          `cache_write=${u.cacheCreationInputTokens} sdk=$${u.costUSD.toFixed(6)} ours=$${est.toFixed(6)} ` +
          `diff=${(diff * 100).toFixed(2)}% ${bad ? "MISMATCH" : "ok"}`,
      );
    }
    const total = r.result?.total_cost_usd ?? 0;
    const totalDiff = total > 0 ? Math.abs(sumEst - total) / total : 1;
    if (totalDiff > TOLERANCE) failed = true;
    console.log(
      `  total_cost_usd=$${total.toFixed(6)} sum_ours=$${sumEst.toFixed(6)} ` +
        `diff=${(totalDiff * 100).toFixed(2)}% ${totalDiff > TOLERANCE ? "MISMATCH" : "ok"}`,
    );
  }
  console.log(failed ? "\nPROBE: FAIL" : "\nPROBE: PASS");
  process.exit(failed ? 1 : 0);
}

void main();
