
import fs from "node:fs";
import path from "node:path";
import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { buildAgentChildEnv, resolveOAuthTokenPool } from "@/services/agents/agent-auth";
import { resolveClaudeBinary } from "@/services/agents/generic-dispatcher";
import { SDK_DISALLOWED_BUILTINS, classifySdkTool } from "@/services/agents/sdk-builtins";
import { withAgentSdkIsolation } from "@/services/agents/sdk-isolation";
import { toOutputFormatJsonSchema } from "@/services/agents/structured-output";
import { MODELS } from "@/services/llm/models";

const SNAPSHOT_ONLY = process.argv.includes("--snapshot-only");
const MODEL = MODELS.anthropic.haiku;
const SPEND_CAP_USD = 2;
const SNAPSHOT_PATH = path.join(
  __dirname,
  "../src/services/agents/__tests__/__fixtures__/sdk-tool-snapshot.json",
);

let spentUsd = 0;
let failed = false;

function report(name: string, pass: boolean, detail: string) {
  if (!pass) failed = true;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}  ${detail}`);
}

function sdkVersion(): string {
  const candidates = [
    path.join(__dirname, "../node_modules/@anthropic-ai/claude-agent-sdk/package.json"),
    path.join(__dirname, "../../../node_modules/@anthropic-ai/claude-agent-sdk/package.json"),
  ];
  const pkg = candidates.find((c) => fs.existsSync(c));
  if (!pkg) throw new Error("claude-agent-sdk is not installed");
  return (JSON.parse(fs.readFileSync(pkg, "utf8")) as { version: string }).version;
}

function childEnv(): Record<string, string | undefined> {
  const token = resolveOAuthTokenPool()[0];
  return buildAgentChildEnv({
    mode: token ? "oauth" : "api_key",
    oauthToken: token,
    apiKey: process.env.ANTHROPIC_API_KEY,
  });
}

function probeServer(onCall: () => void) {
  return createSdkMcpServer({
    name: "probe",
    version: "1.0.0",
    tools: [
      tool("get_number", "Returns the secret number.", { _u: z.string().optional() }, async () => {
        onCall();
        return { content: [{ type: "text", text: "4242" }] };
      }),
    ],
  });
}

type Msg = {
  type: string;
  subtype?: string;
  tools?: string[];
  result?: string;
  total_cost_usd?: number;
  structured_output?: unknown;
  message?: { content?: Array<{ type: string; name?: string; text?: string; input?: unknown }> };
};

type HookFn = (input: unknown) => Promise<Record<string, unknown>>;

async function run(args: {
  prompt: string;
  disallow?: boolean;
  outputFormat?: { type: "json_schema"; schema: Record<string, unknown> };
  preToolUse?: HookFn;
  env?: Record<string, string | undefined>;
  stopAtInit?: boolean;
  onCall?: () => void;
  maxTurns?: number;
}): Promise<{ init: Msg | null; messages: Msg[]; result: Msg | null; error?: string }> {
  const abort = new AbortController();
  const messages: Msg[] = [];
  let init: Msg | null = null;
  let result: Msg | null = null;
  try {
    for await (const raw of query({
      prompt: args.prompt,
      options: withAgentSdkIsolation({
        model: MODEL,
        env: args.env ?? childEnv(),
        abortController: abort,
        mcpServers: { probe: probeServer(args.onCall ?? (() => {})) },
        maxTurns: args.stopAtInit ? 1 : (args.maxTurns ?? 4),
        ...(args.disallow === false ? {} : { disallowedTools: [...SDK_DISALLOWED_BUILTINS] }),
        ...(args.outputFormat ? { outputFormat: args.outputFormat } : {}),
        ...(resolveClaudeBinary() ? { pathToClaudeCodeExecutable: resolveClaudeBinary() } : {}),
        ...(args.preToolUse
          ? { hooks: { PreToolUse: [{ hooks: [args.preToolUse as never] }] } }
          : {}),
        canUseTool: async (_n: string, input: Record<string, unknown>) =>
          args.stopAtInit
            ? { behavior: "deny" as const, message: "sdk-contract snapshot: no tools" }
            : { behavior: "allow" as const, updatedInput: input },
      }),
    })) {
      const m = raw as unknown as Msg;
      messages.push(m);
      if (m.type === "system" && m.subtype === "init") {
        init = m;
        if (args.stopAtInit) {
          abort.abort();
          break;
        }
      }
      if (m.type === "result") {
        result = m;
        spentUsd += m.total_cost_usd ?? 0;
      }
    }
  } catch (e) {
    if (!args.stopAtInit) return { init, messages, result, error: (e as Error).message };
  }
  return { init, messages, result };
}

function toolUses(messages: Msg[]): string[] {
  return messages
    .filter((m) => m.type === "assistant")
    .flatMap((m) => m.message?.content ?? [])
    .filter((b) => b.type === "tool_use")
    .map((b) => String(b.name));
}

function builtins(tools: string[] | undefined): string[] {
  return [...new Set((tools ?? []).filter((t) => !t.startsWith("mcp__")))].sort();
}

async function snapshot() {
  const engineerFormat = toOutputFormatJsonSchema("engineer");
  const env = { ...childEnv(), ENABLE_TOOL_SEARCH: "true" };
  const all = await run({ prompt: "hi", disallow: false, outputFormat: engineerFormat, env, stopAtInit: true });
  const exposed = await run({ prompt: "hi", outputFormat: engineerFormat, env, stopAtInit: true });
  if (!all.init?.tools || !exposed.init?.tools) {
    report("snapshot", false, "no system/init tool list captured");
    return;
  }
  const snap = {
    sdk_version: sdkVersion(),
    captured_at: new Date().toISOString().slice(0, 10),
    note: "Regenerate with scripts/sdk-contract.ts on every SDK bump. Non-MCP tool names only.",
    all_builtin_tools: builtins(all.init.tools),
    exposed_with_our_disallow: builtins(exposed.init.tools),
  };
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snap, null, 2) + "\n");
  const unclassified = snap.all_builtin_tools.filter((t) => classifySdkTool(t) === "unclassified");
  report(
    "snapshot",
    unclassified.length === 0,
    `sdk=${snap.sdk_version} all=${snap.all_builtin_tools.length} exposed=${JSON.stringify(snap.exposed_with_our_disallow)}` +
      (unclassified.length ? ` UNCLASSIFIED=${JSON.stringify(unclassified)}` : ""),
  );
}

async function checkDenyContinues() {
  let calls = 0;
  let fired = 0;
  const r = await run({
    prompt:
      "Call the get_number tool once. If the call is refused, do not retry: reply with one short sentence saying it was refused.",
    onCall: () => calls++,
    preToolUse: async (input) => {
      const name = String((input as { tool_name?: string }).tool_name);
      if (!name.endsWith("get_number")) return {};
      fired++;
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "denied by policy",
        },
      };
    },
  });
  const text = (r.result?.result ?? "").trim();
  report(
    "(a) deny without continue:false keeps going",
    fired > 0 && calls === 0 && r.result?.subtype === "success" && text.length > 0,
    `hook_fired=${fired} tool_ran=${calls} subtype=${r.result?.subtype} text=${JSON.stringify(text.slice(0, 60))}${r.error ? ` error=${r.error}` : ""}`,
  );
}

async function checkContinueFalseEnds() {
  let calls = 0;
  let firedAt = -1;
  const r = await run({
    prompt: "Call the get_number tool once, then reply with just the number.",
    onCall: () => calls++,
    preToolUse: async (input) => {
      const name = String((input as { tool_name?: string }).tool_name);
      if (!name.endsWith("get_number")) return {};
      if (firedAt < 0) firedAt = Date.now();
      return {
        continue: false,
        stopReason: "contract_stop",
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "stopped by policy",
        },
      };
    },
  });
  const idx = r.messages.findIndex(
    (m) => m.type === "assistant" && (m.message?.content ?? []).some((b) => b.type === "tool_use" && String(b.name).endsWith("get_number")),
  );
  const after = idx < 0 ? [] : r.messages.slice(idx + 1).filter((m) => m.type === "assistant");
  report(
    "(b) continue:false ends the run",
    firedAt > 0 && idx >= 0 && calls === 0 && after.length === 0,
    `hook_fired=${firedAt > 0} tool_use_found=${idx >= 0} tool_ran=${calls} assistant_msgs_after=${after.length} subtype=${r.result?.subtype ?? "none"}${r.error ? ` error=${r.error}` : ""}`,
  );
}

async function checkEngineerOutputFormat() {
  const r = await run({
    prompt:
      "Informational question, no code change: in one sentence, what does `git status` show? Answer through the structured output.",
    outputFormat: toOutputFormatJsonSchema("engineer"),
  });
  const so = r.result?.structured_output as { rendered_markdown?: unknown } | undefined;
  report(
    "(c) engineer outputFormat returns structured output",
    r.result?.subtype === "success" && !!so && typeof so.rendered_markdown === "string" && so.rendered_markdown.length > 0,
    `subtype=${r.result?.subtype} structured_keys=${so ? JSON.stringify(Object.keys(so)) : "none"}${r.error ? ` error=${r.error}` : ""}`,
  );
}

async function checkToolSearch() {
  let calls = 0;
  const r = await run({
    prompt: "Use the get_number tool (load it first if you need to), then reply with just the number.",
    env: { ...childEnv(), ENABLE_TOOL_SEARCH: "true" },
    onCall: () => calls++,
  });
  const used = toolUses(r.messages);
  report(
    "(d) ToolSearch loads a deferred MCP tool",
    used.includes("ToolSearch") &&
      used.findIndex((n) => n.endsWith("get_number")) > used.indexOf("ToolSearch") &&
      calls > 0 &&
      (r.result?.result ?? "").includes("4242"),
    `tool_uses=${JSON.stringify(used)} tool_ran=${calls} reply=${JSON.stringify((r.result?.result ?? "").slice(0, 40))}${r.error ? ` error=${r.error}` : ""}`,
  );
}

async function main() {
  console.log(`Agent SDK contract, sdk ${sdkVersion()}, model ${MODEL}`);
  await snapshot();
  if (!SNAPSHOT_ONLY) {
    for (const check of [checkDenyContinues, checkContinueFalseEnds, checkEngineerOutputFormat, checkToolSearch]) {
      if (spentUsd >= SPEND_CAP_USD) {
        report(check.name, false, `skipped: spend cap $${SPEND_CAP_USD} reached`);
        continue;
      }
      await check();
    }
  }
  console.log(`spent $${spentUsd.toFixed(4)}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
