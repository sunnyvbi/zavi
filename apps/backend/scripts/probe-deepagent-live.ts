
import { LangChainDeepAgentEngine } from "../src/services/agents/deepagent";
import {
  deepAgentModelId,
  resolveDeepAgentModel,
} from "../src/services/agents/deepagent/resolve-model";
import {
  STUDIO_TOOLS,
  makeStudioDispatchTool,
  type StudioToolLog,
} from "../src/services/agents/deepagent/studio/local-funnel";
import {
  toOutputFormatJsonSchema,
  reduceStructuredOutput,
  getServerSchema,
} from "../src/services/agents/structured-output";
import { estimateEngineCostUsd } from "../src/services/llm/engine-cost";
import type {
  AgentEngineRunSpec,
  EngineEvent,
  EngineToolCall,
} from "../src/services/agents/engine/types";

process.env.LANGSMITH_PROJECT ||= "zavi-deepagent-probe";

type Check = { name: string; ok: boolean; detail: string };

type RunOut = {
  events: EngineEvent[];
  text: string;
  deltas: number;
  firstDeltaMs: number | null;
  calls: Array<{ tool: string; input: unknown; denied: boolean }>;
  terminal: Extract<EngineEvent, { type: "terminal" }> | null;
  wallMs: number;
};

const SYSTEM = [
  "You are Zavi, a growth operator for a peer-to-peer car rental marketplace (Upcar).",
  "Optimize on COMPLETED RENTALS, never clicks alone. Cite the tool result behind every number.",
  "A proposal is a proposal — never describe an unexecuted change as done.",
].join("\n");

async function runOne(args: {
  prompt: string;
  maxTurns: number;
  outputSlug?: string;
  tenantId?: string;
}): Promise<RunOut> {
  const log: StudioToolLog[] = [];
  const base = makeStudioDispatchTool(log);
  const calls: RunOut["calls"] = [];
  const dispatchTool = async (call: EngineToolCall) => {
    const res = await base(call);
    calls.push({ tool: call.tool_name, input: call.input, denied: !!res.denied });
    return res;
  };

  const spec: AgentEngineRunSpec = {
    systemPrompt: SYSTEM,
    userPrompt: args.prompt,
    model: "claude-sonnet-4-6",
    maxTurns: args.maxTurns,
    tools: STUDIO_TOOLS,
    resume: null,
    abort: new AbortController(),
    dispatchTool,
    onEvent: () => {},
    runId: "probe-local",
    ...(args.tenantId ? { tenantId: args.tenantId } : {}),
    ...(args.outputSlug
      ? { outputJsonSchema: toOutputFormatJsonSchema(args.outputSlug) }
      : {}),
  } as AgentEngineRunSpec;

  const started = Date.now();
  const out: RunOut = {
    events: [],
    text: "",
    deltas: 0,
    firstDeltaMs: null,
    calls,
    terminal: null,
    wallMs: 0,
  };

  const engine = new LangChainDeepAgentEngine({ mountMemory: Boolean(args.tenantId) });
  for await (const ev of engine.run(spec)) {
    out.events.push(ev);
    if (ev.type === "text_delta") {
      out.deltas += 1;
      out.firstDeltaMs ??= Date.now() - started;
      out.text += ev.text;
    }
    if (ev.type === "terminal") out.terminal = ev;
  }
  out.wallMs = Date.now() - started;
  return out;
}

function check(name: string, ok: boolean, detail: string): Check {
  return { name, ok, detail };
}

async function scenarioTools(): Promise<Check[]> {
  const r = await runOne({
    maxTurns: 14,
    prompt:
      "Why is cost per completed rental rising in Austin over the last 14 days? " +
      "Pull the Meta campaigns and the marketplace bookings, reconcile them, and give me " +
      "ONE ranked next action.",
  });

  const nonDenied = r.calls.filter((c) => !c.denied);
  const emptyArgs = nonDenied.filter(
    (c) => !c.input || Object.keys(c.input as object).length === 0,
  );
  return [
    check("streams text incrementally", r.deltas > 1, `${r.deltas} deltas, first at ${r.firstDeltaMs}ms`),
    check("calls real tools through the funnel", nonDenied.length > 0, nonDenied.map((c) => c.tool).join(", ") || "none"),
    check(
      "tool arguments are non-empty (the `{}` failure mode)",
      nonDenied.length > 0 && emptyArgs.length === 0,
      emptyArgs.length ? `EMPTY: ${emptyArgs.map((c) => c.tool).join(", ")}` : "all populated",
    ),
    check("terminates cleanly", r.terminal?.stopReason === "end_turn", String(r.terminal?.stopReason)),
    check("reports usage", (r.terminal?.usage.input_tokens ?? 0) > 0 && (r.terminal?.usage.output_tokens ?? 0) > 0, JSON.stringify(r.terminal?.usage)),
    check(
      "cost prices on the OpenAI table, not Claude MAX",
      (() => {
        const u = r.terminal?.usage;
        if (!u) return false;
        const c = estimateEngineCostUsd("langchain", "gpt-5.5", u);
        return c > 0 && c < 5;
      })(),
      `$${estimateEngineCostUsd("langchain", "gpt-5.5", r.terminal!.usage).toFixed(4)} for ${r.wallMs}ms`,
    ),
  ];
}

async function scenarioStructured(): Promise<Check[]> {
  const slug = "research";
  const r = await runOne({
    maxTurns: 10,
    outputSlug: slug,
    prompt:
      "Give me a short research brief on how weekend rental demand in Austin is trending. " +
      "Use the tools you have. Keep it to a few paragraphs.",
  });

  const so = r.terminal?.structuredOutput;
  const reduced =
    so != null
      ? reduceStructuredOutput({
          slug,
          structuredOutput: so,
          serverSchema: getServerSchema(slug),
          rawTextFallback: r.text,
        })
      : null;

  return [
    check("terminal carries structuredOutput", so != null, so == null ? "NULL — the state key never reached the engine" : `keys: ${Object.keys(so as object).join(", ")}`),
    check(
      "the dispatcher's reduction accepts it",
      !!reduced?.parseOk,
      reduced ? `parseOk=${reduced.parseOk} code=${reduced.telemetryCode}` : "not run",
    ),
    check(
      "rendered_markdown is non-empty (this is what the user sees)",
      typeof (so as { rendered_markdown?: unknown })?.rendered_markdown === "string" &&
        ((so as { rendered_markdown: string }).rendered_markdown?.length ?? 0) > 50,
      `${((so as { rendered_markdown?: string })?.rendered_markdown ?? "").length} chars`,
    ),
    check(
      "a structured run is end_turn even with no free text",
      r.terminal?.stopReason === "end_turn",
      `stopReason=${r.terminal?.stopReason}, text=${r.text.length} chars`,
    ),
  ];
}

async function scenarioSubagent(): Promise<Check[]> {
  const r = await runOne({
    maxTurns: 16,
    prompt:
      "Meta reports 120 conversions in Austin last week; the marketplace shows 78 completed rentals. " +
      "You MUST delegate the reconciliation to the `data-reconciler` subagent using the task tool — " +
      "do not run the queries yourself. Report what it found.",
  });
  const lower = r.text.toLowerCase();
  return [
    check("run completes with delegation asked for", r.terminal?.stopReason === "end_turn", String(r.terminal?.stopReason)),
    check(
      "usage includes subgraph tokens (the 15x bleed guard)",
      (r.terminal?.usage.input_tokens ?? 0) > 5000,
      `${r.terminal?.usage.input_tokens} input tokens — a delegated run should be well above a single turn`,
    ),
    check("answer references the reconciliation", /reconcil|120|78/.test(lower), `${r.text.length} chars of reply`),
  ];
}

async function scenarioDenial(): Promise<Check[]> {
  const r = await runOne({
    maxTurns: 6,
    prompt:
      "Call the slack__post_message tool RIGHT NOW with channel \"#growth\" and text " +
      "\"probe\". Do it as your very first action, before anything else. Then tell me " +
      "exactly what happened.",
  });
  const denied = r.calls.filter((c) => c.denied);
  const lower = r.text.toLowerCase();
  return [
    check("the write tool was actually attempted", r.calls.some((c) => c.tool === "slack__post_message"), r.calls.map((c) => c.tool).join(", ") || "none"),
    check("the funnel DENIED it", denied.length > 0, denied.map((c) => c.tool).join(", ") || "not denied"),
    check("the run survives the denial (no throw, no dead end)", r.terminal?.stopReason === "end_turn", String(r.terminal?.stopReason)),
    check(
      "the agent tells the truth about it",
      /(denied|blocked|refus|not permitted|couldn't|could not|unable|disabled)/i.test(lower),
      `${r.text.slice(0, 120).replace(/\n/g, " ")}…`,
    ),
  ];
}

async function scenarioTodos(): Promise<Check[]> {
  const r = await runOne({
    maxTurns: 8,
    prompt:
      "Before doing anything else, call write_todos with your plan for diagnosing " +
      "why Austin cost per completed rental is rising. Then work the first item only.",
  });
  return [
    check("run completes", r.terminal?.stopReason === "end_turn", String(r.terminal?.stopReason)),
    check("produced a plan-shaped answer", r.text.length > 100, `${r.text.length} chars (see the trace for write_todos)`),
  ];
}

async function scenarioMemory(): Promise<Check[]> {
  const tenantId =
    process.env.PROBE_TENANT_ID || "73db45ff-457e-4541-bc8f-bdb625390204";
  const r = await runOne({
    maxTurns: 8,
    tenantId,
    prompt:
      "List the files under /memory/ and read /memory/company.md. Quote the first " +
      "line of it back to me verbatim. If the mount is empty, say exactly that.",
  });
  const lower = r.text.toLowerCase();
  const missing = /not found|no files|empty|could not read|couldn't read/.test(lower);
  return [
    check("run completes", r.terminal?.stopReason === "end_turn", String(r.terminal?.stopReason)),
    check(
      "the tenant's real anchors are readable through tenantClient",
      !missing && r.text.length > 100,
      missing ? "mount looked EMPTY — check the tenantClient migration" : `${r.text.length} chars quoted back`,
    ),
  ];
}

async function main() {
  const only = process.env.ONLY;
  const model = resolveDeepAgentModel(deepAgentModelId("claude-sonnet-4-6"));
  console.log("── preflight ─────────────────────────────────────────────");
  console.log(`  agent.md model  : claude-sonnet-4-6 (bare)`);
  console.log(
    `  resolved model  : ${typeof model === "string" ? model : `${model.constructor.name}(${(model as { model?: string }).model})`}`,
  );
  console.log(`  langsmith       : ${process.env.LANGSMITH_TRACING === "true" ? process.env.LANGSMITH_PROJECT : "off"}`);
  if (typeof model !== "string" && (model as { model?: string }).model !== "gpt-5.5") {
    console.error("  !! not routed to Codex gpt-5.5 — check CODEX_ACCESS_TOKEN");
  }

  const suites: Array<[string, () => Promise<Check[]>]> = [
    ["tools + streaming", scenarioTools],
    ["structured output", scenarioStructured],
    ["subagent delegation", scenarioSubagent],
    ["denial path", scenarioDenial],
    ["todo middleware", scenarioTodos],
    ["memory mount", scenarioMemory],
  ];

  let failed = 0;
  for (const [name, fn] of suites) {
    if (only && !name.includes(only)) continue;
    console.log(`\n── ${name} ──────────────────────────────────────`);
    try {
      for (const c of await fn()) {
        console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name}\n        ${c.detail}`);
        if (!c.ok) failed += 1;
      }
    } catch (e) {
      failed += 1;
      console.error(`  FAIL  threw: ${(e as Error).message}`);
    }
  }
  console.log(`\n${failed === 0 ? "ALL CHECKS PASSED" : `${failed} CHECK(S) FAILED`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("probe crashed:", e);
  process.exit(1);
});
