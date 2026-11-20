
import {
  enqueueAgentRun,
  claimAgentRun,
  buildContext,
  runDispatch,
  persistTerminal,
} from "../src/services/agents/runner";
import { resolveRunEngine } from "../src/services/agents/engine/resolve-run-engine";
import { loadGlobalAgentDefinition } from "../src/services/agents/registry";
import { serviceClient } from "../src/services/supabase";
import { estimateEngineCostUsd } from "../src/services/llm/engine-cost";

const TENANT = process.env.PROBE_TENANT_ID || "5f05d826-7793-45d1-88f9-c5c5bb3f0347";
const SLUG = process.env.PROBE_AGENT_SLUG || "research";
const PROMPT =
  process.env.PROBE_PROMPT ||
  "In 3 short paragraphs: what does this company do, and what is the single " +
    "biggest risk to its growth right now? You MUST call memory__search at least " +
    "once to ground this in the company brain, and say what you found. Be specific.";

function ok(name: string, pass: boolean, detail: string) {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}\n        ${detail}`);
  return pass ? 0 : 1;
}

async function main() {
  const def = loadGlobalAgentDefinition(SLUG);
  if (!def) throw new Error(`unknown agent ${SLUG}`);
  const resolved = await resolveRunEngine(TENANT, SLUG, def.metadata_praxis);

  console.log("── preflight ─────────────────────────────────────────────");
  console.log(`  tenant   : ${TENANT}`);
  console.log(`  agent    : ${SLUG}`);
  console.log(`  provider : ${resolved.provider} (${resolved.source})`);
  console.log(`  model    : ${resolved.model}`);
  if (resolved.provider !== "langchain") {
    console.error(
      `\n  ABORT — this run would take the ${resolved.provider} path, not the harness.\n` +
        `  Set provider: langchain in src/agents/${SLUG}/agent.md, or add an override row.`,
    );
    process.exit(2);
  }

  const started = Date.now();
  const { run_id } = await enqueueAgentRun({
    tenant_id: TENANT,
    agent_slug: SLUG,
    trigger: "cron",
    payload: { instruction: PROMPT, source: "deepagent-e2e-probe" },
    cron_dedupe_key: `deepagent-e2e-${Date.now()}`,
  } as never);
  console.log(`\n  run_id   : ${run_id}`);

  const claim = await claimAgentRun(run_id);
  if (!claim) throw new Error("claim_agent_run returned null (already claimed?)");
  const ctx = await buildContext(claim, run_id);

  let result: Awaited<ReturnType<typeof runDispatch>> | null = null;
  let err: string | null = null;
  try {
    result = await runDispatch(ctx, claim.payload);
  } catch (e) {
    err = (e as Error).message;
    console.error(`\n  runDispatch THREW: ${err}`);
  }
  await persistTerminal(
    run_id,
    SLUG,
    result,
    err,
    resolved.model,
    claim.payload,
    claim.trigger,
    TENANT,
  );
  const wallMs = Date.now() - started;

  const sb = serviceClient();
  const { data: row } = await sb
    .from("agent_runs")
    .select("status, output_text, cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, error, parse_ok, parse_error, model_used")
    .eq("id", run_id)
    .maybeSingle<{
      status: string;
      output_text: string | null;
      cost_usd: number | null;
      input_tokens: number | null;
      output_tokens: number | null;
      cache_read_tokens: number | null;
      cache_creation_tokens: number | null;
      error: string | null;
      parse_ok: boolean | null;
      parse_error: string | null;
      model_used: string | null;
    }>();
  const { data: events } = await sb
    .from("agent_run_events")
    .select("stage, meta")
    .eq("agent_run_id", run_id)
    .order("created_at", { ascending: true });

  const stages = (events ?? []).map((e) => (e as { stage: string }).stage);
  const toolEvents = (events ?? []).filter(
    (e) => (e as { stage: string }).stage.startsWith("tool_use"),
  );
  const metaKeys = new Set<string>();
  for (const e of events ?? []) {
    for (const k of Object.keys(((e as { meta?: object }).meta ?? {}) as object)) {
      metaKeys.add(k);
    }
  }
  const C14 = new Set(["tool_name", "ms", "code", "iter"]);
  const leaked = [...metaKeys].filter((k) => !C14.has(k));

  console.log(`\n── result (${(wallMs / 1000).toFixed(1)}s) ─────────────────────────────`);
  let bad = 0;
  bad += ok("run reached a terminal status", row?.status === "success", `status=${row?.status} parse_ok=${row?.parse_ok} err=${row?.error ?? "none"} model_used=${row?.model_used}`);
  bad += ok("output_text is populated (this is the chat bubble)", (row?.output_text ?? "").length > 100, `${(row?.output_text ?? "").length} chars`);
  bad += ok("usage persisted", (row?.input_tokens ?? 0) > 0 && (row?.output_tokens ?? 0) > 0, `in=${row?.input_tokens} out=${row?.output_tokens}`);
  bad += ok("cost persisted and is sane", (row?.cost_usd ?? 0) > 0 && (row?.cost_usd ?? 99) < 10, `$${row?.cost_usd}`);
  bad += ok("progress rows written", stages.length > 0, `${stages.length} events: ${[...new Set(stages)].join(", ")}`);
  bad += ok("tools ran through the funnel", toolEvents.length > 0, `${toolEvents.length} tool events`);
  bad += ok(
    "agent_run_events.meta stays inside the C14 whitelist",
    leaked.length === 0,
    leaked.length ? `LEAKED KEYS: ${leaked.join(", ")}` : `keys: ${[...metaKeys].join(", ") || "none"}`,
  );
  const usage = {
    input_tokens: row?.input_tokens ?? 0,
    output_tokens: row?.output_tokens ?? 0,
    cache_read_input_tokens: row?.cache_read_tokens ?? 0,
    cache_creation_input_tokens: row?.cache_creation_tokens ?? 0,
  };
  const asRan = estimateEngineCostUsd("langchain", "gpt-5.5", usage);
  const asDeclared = estimateEngineCostUsd("langchain", row?.model_used ?? "claude-opus-4-7", usage);
  const recorded = row?.cost_usd ?? 0;
  bad += ok(
    "cost is priced on the model that RAN, not the agent.md id",
    Math.abs(recorded - asRan) < Math.abs(recorded - asDeclared) ||
      Math.abs(recorded - asRan) < 0.01,
    `recorded $${recorded} | as-ran(gpt-5.5) $${asRan.toFixed(4)} | as-declared(${row?.model_used}) $${asDeclared.toFixed(4)}`,
  );
  bad += ok("no parse_failed", !stages.includes("parse_failed"), stages.includes("parse_failed") ? "envelope did NOT parse" : "envelope parsed");

  console.log(`\n  --- output_text (first 400) ---\n${(row?.output_text ?? "").slice(0, 400)}\n`);
  console.log(bad === 0 ? "ALL CHECKS PASSED" : `${bad} CHECK(S) FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("e2e probe crashed:", e);
  process.exit(1);
});
