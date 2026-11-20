#!/usr/bin/env tsx

import { serviceClient } from "../src/services/supabase";
import { isShadowTenantAllowed } from "../src/services/eval/shadow-tenant-allowlist";
import { buildContext, type ClaimedAgentRun } from "../src/services/agents/runner";
import { runGeneric } from "../src/services/agents/generic-dispatcher";
import { getOpenAi } from "../src/services/openai";
import { getCodexClient } from "../src/services/codex-subscription";
import { MODELS } from "../src/services/llm/models";
import { buildShadowToolResults } from "../src/services/agents/engine/shadow-tool-policy";
import {
  createShadowSandboxForRun,
  destroyShadowSandbox,
  ShadowSandboxProvisionError,
  type ShadowSandboxHandle,
} from "../src/services/sandbox/shadow-lifecycle";
import type { ToolCallTrace } from "../src/services/tools/types";
import type { AgentTrigger, DispatcherResult } from "../src/services/agents/types";
import {
  HarnessFailure,
  classifyFailureOrigin as classifyFailureOriginFor,
  resolveHarnessSha,
  preflightInstrumentSelfTest as sharedSelfTest,
  parsePromptSnapshot,
  buildEvidencePacket,
} from "../src/services/eval/shadow-harness";

let SHADOW_PROVIDER: "openai" | "bedrock" | "fireworks" | "codex" = "openai";
let SHADOW_MODEL = process.env.PRAXIS_SHADOW_OPENAI_MODEL || "gpt-5.5";

export { HarnessFailure };

export function classifyFailureOrigin(
  err: unknown,
): "model" | "harness" | "unknown" {
  return classifyFailureOriginFor(err, SHADOW_PROVIDER);
}

function harnessSha(): string {
  return resolveHarnessSha();
}

async function preflightInstrumentSelfTest(): Promise<void> {
  if (SHADOW_PROVIDER !== "fireworks") return;
  await sharedSelfTest({
    label: "fireworks",
    baseURL:
      process.env.FIREWORKS_BASE_URL || "https://api.fireworks.ai/inference/v1",
    apiKey: process.env.FIREWORKS_API_KEY ?? "",
    model: SHADOW_MODEL,
  });
  console.log(
    `instrument self-test PASSED for ${SHADOW_MODEL} (tools+response_format, assistant block-array)`,
  );
}
const SHADOW_AGENTS = new Set([
  "support-lead",
  "pm",
  "advisor",
  "chief-of-staff",
  "operator",
  "performance-marketer",
  "research",
  "growth-lead",
  "engineer",
]);

const SHADOW_SANDBOX_AGENTS = new Set(["engineer"]);

function effectiveShadowAgents(): Set<string> {
  if (SHADOW_PROVIDER !== "bedrock" && SHADOW_PROVIDER !== "fireworks") {
    return SHADOW_AGENTS;
  }
  return new Set([...SHADOW_AGENTS].filter((a) => !SHADOW_SANDBOX_AGENTS.has(a)));
}

function shadowBudgetEstimateUsd(agent_slug: string): number {
  return SHADOW_SANDBOX_AGENTS.has(agent_slug) ? 2.5 : 0.5;
}

export { parsePromptSnapshot, buildEvidencePacket };

type Args = {
  tenant?: string;
  source?: string;
  agent?: string;
  limit: number;
  provider: "openai" | "bedrock" | "fireworks" | "codex";
};

function parseArgs(argv: string[]): Args {
  const out: Args = { limit: 5, provider: "openai" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--tenant") out.tenant = argv[++i];
    else if (argv[i] === "--source") out.source = argv[++i];
    else if (argv[i] === "--agent") out.agent = argv[++i];
    else if (argv[i] === "--limit") out.limit = Math.max(1, Number(argv[++i]) || 5);
    else if (argv[i] === "--provider") {
      const p = argv[++i];
      out.provider =
        p === "bedrock"
          ? "bedrock"
          : p === "fireworks"
            ? "fireworks"
            : p === "codex"
              ? "codex"
              : "openai";
    }
  }
  return out;
}

type SourceRow = {
  id: string;
  tenant_id: string;
  agent_slug: string;
  trigger: AgentTrigger;
  payload: unknown;
  raw_response_text: string | null;
  prompt_snapshot: string | null;
  tool_calls: unknown;
  status: string;
};

function assertSourceTenantMatches(row: SourceRow, allowedTenant: string): void {
  if (row.tenant_id !== allowedTenant) {
    throw new Error(
      `shadow replay tenant mismatch (source ${row.id} is ${row.tenant_id}, ` +
        `requested ${allowedTenant})`,
    );
  }
}

async function selectSources(args: Args): Promise<SourceRow[]> {
  const sb = serviceClient();
  const tenant = args.tenant ?? "";
  if (!(await isShadowTenantAllowed(tenant))) {
    throw new Error(
      `tenant ${tenant || "(missing)"} is not on the shadow allowlist — refusing to select sources`,
    );
  }
  let q = sb
    .from("agent_runs")
    .select("id, tenant_id, agent_slug, trigger, payload, raw_response_text, prompt_snapshot, tool_calls, status")
    .eq("tenant_id", tenant)
    .eq("status", "success")
    .not("prompt_snapshot", "is", null);
  if (args.source) {
    q = q.eq("id", args.source);
  } else if (args.agent) {
    q = q.eq("agent_slug", args.agent).order("enqueued_at", { ascending: false }).limit(args.limit);
  } else {
    q = q.in("agent_slug", [...effectiveShadowAgents()]).order("enqueued_at", { ascending: false }).limit(args.limit);
  }
  const { data, error } = await q;
  if (error) throw new Error(`source select failed: ${error.message}`);
  return (data ?? []) as SourceRow[];
}

async function replayOne(row: SourceRow, allowedTenant: string): Promise<string> {
  const sb = serviceClient();
  assertSourceTenantMatches(row, allowedTenant);
  if (!effectiveShadowAgents().has(row.agent_slug)) {
    return `skip ${row.id}: agent ${row.agent_slug} not in shadow set for provider ${SHADOW_PROVIDER}`;
  }

  const pre = parsePromptSnapshot(row.prompt_snapshot, row.trigger === "chat");
  if (!pre) {
    return `skip ${row.id}: no/ambiguous prompt_snapshot (cannot replay faithfully)`;
  }

  const needsSandbox = SHADOW_SANDBOX_AGENTS.has(row.agent_slug);

  let handle: ShadowSandboxHandle | undefined;
  if (needsSandbox) {
    try {
      handle = await createShadowSandboxForRun({
        run_id: row.id,
        tenant_id: row.tenant_id,
        payload: row.payload ?? null,
      });
    } catch (e) {
      if (e instanceof ShadowSandboxProvisionError) {
        await destroyShadowSandbox(e.sandbox_id);
      }
      return `skip ${row.id}: shadow sandbox provision failed: ${(e as Error).message}`;
    }
  }

  try {
    const { data: budget, error: budgetErr } = await sb.rpc(
      "consume_shadow_budget_or_reject",
      { p_estimated_usd: shadowBudgetEstimateUsd(row.agent_slug) },
    );
    if (budgetErr) return `skip ${row.id}: budget RPC error ${budgetErr.message}`;
    if (budget !== "charged") return `skip ${row.id}: budget ${budget}`;

    const claim: ClaimedAgentRun = {
      id: row.id,
      tenant_id: row.tenant_id,
      agent_slug: row.agent_slug,
      trigger: row.trigger,
      payload: row.payload ?? null,
    };

    const ctx = await buildContext(claim, row.id);
    ctx.shadow_mode = true;
    ctx.emitDecision = async () => "shadow_noop";
    ctx.emitProgress = async () => {};
    ctx.shadow_prompt_override = pre;

    if (needsSandbox && handle) {
      ctx.shadow_sandbox_id = handle.sandbox_id;
    } else {
      const captured = Array.isArray(row.tool_calls)
        ? (row.tool_calls as ToolCallTrace[])
        : [];
      ctx.shadow_tool_results = buildShadowToolResults(captured);
      if (process.env.PRAXIS_SHADOW_INJECT_EVIDENCE !== "0") {
        const packet = buildEvidencePacket(captured);
        if (packet) {
          ctx.shadow_prompt_override = {
            system: pre.system + packet,
            initial_user: pre.initial_user,
          };
        }
      }
    }

    return await runReplayAndPersist(sb, row, ctx, claim);
  } finally {
    await destroyShadowSandbox(handle?.sandbox_id);
  }
}

async function runReplayAndPersist(
  sb: ReturnType<typeof serviceClient>,
  row: SourceRow,
  ctx: Awaited<ReturnType<typeof buildContext>>,
  claim: ClaimedAgentRun,
): Promise<string> {
  const t0 = Date.now();
  let result: DispatcherResult | null = null;
  let status = "dispatch_error";
  let error: string | null = null;
  let failureOrigin: "none" | "model" | "harness" | "unknown" = "none";
  try {
    result = await runGeneric(ctx, claim.payload);
    status = result.parse_ok ? "success" : "parse_failed";
    if (!result.parse_ok) {
      error = result.parse_error ?? "parse_failed (dispatcher reported no reason)";
    }
  } catch (e) {
    failureOrigin = classifyFailureOrigin(e);
    if (failureOrigin === "harness") {
      throw new HarnessFailure((e as Error).message);
    }
    error = (e as Error).message;
  }

  const parsedKind = (result?.parsed as { envelope_kind?: string } | null | undefined)?.envelope_kind;
  if (parsedKind === "setup_required") {
    return `skip ${row.id}: setup short-circuit (LLM not called — not a real replay)`;
  }
  const latencyMs = Date.now() - t0;

  const deterministic = {
    completed: result !== null,
    parse_ok: result?.parse_ok ?? false,
    harness_sha: harnessSha(),
    failure_origin: failureOrigin,
  };

  const { data: shadowId, error: insErr } = await sb.rpc("insert_shadow_run", {
    p_source_agent_run_id: row.id,
    p_provider: SHADOW_PROVIDER,
    p_model: SHADOW_MODEL,
    p_mode: "offline_replay",
    p_comparison_basis: "raw_vs_raw",
    p_status: status,
    p_parse_ok: result?.parse_ok ?? null,
    p_output_text: result?.output_text ?? null,
    p_parsed_output: (result?.parsed as object) ?? null,
    p_tool_calls: result?.tool_calls ?? [],
    p_usage: result?.usage ?? null,
    p_cost_usd: result?.usage?.cost_usd ?? 0,
    p_latency_ms: latencyMs,
    p_deterministic_checks: deterministic,
    p_comparison_score: null,
    p_comparison_notes: null,
    p_error: error,
  });
  if (insErr) return `FAIL ${row.id}: insert_shadow_run ${insErr.message}`;
  return `ok ${row.id} → shadow ${shadowId ?? "(dup)"} status=${status} ${latencyMs}ms`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.tenant) {
    console.error(
      "--tenant <uuid> is required. Dogfood (73db45ff) is always allowed; a " +
        "customer tenant must be opted into system_config.blob.shadow_customer_tenant_ids.",
    );
    process.exit(1);
  }
  if (!(await isShadowTenantAllowed(args.tenant))) {
    console.error(
      `tenant ${args.tenant} is not on the shadow allowlist — aborting (fail-closed).`,
    );
    process.exit(1);
  }

  SHADOW_PROVIDER = args.provider;
  if (SHADOW_PROVIDER === "bedrock") {
    SHADOW_MODEL =
      process.env.PRAXIS_SHADOW_BEDROCK_MODEL || MODELS.bedrock.qwen3Next80b;
    process.env.PRAXIS_SHADOW_PROVIDER = "bedrock";
    process.env.PRAXIS_SHADOW_BEDROCK_MODEL = SHADOW_MODEL;
    if (
      !process.env.BEDROCK_OPENAI_BASE_URL ||
      !process.env.AWS_BEARER_TOKEN_BEDROCK
    ) {
      console.error(
        "BEDROCK_OPENAI_BASE_URL and/or AWS_BEARER_TOKEN_BEDROCK absent — " +
          "cannot run a --provider bedrock shadow replay. Aborting.",
      );
      process.exit(1);
    }
  } else if (SHADOW_PROVIDER === "fireworks") {
    SHADOW_MODEL =
      process.env.PRAXIS_SHADOW_FIREWORKS_MODEL || MODELS.fireworks.glm52;
    process.env.PRAXIS_SHADOW_PROVIDER = "fireworks";
    process.env.PRAXIS_SHADOW_FIREWORKS_MODEL = SHADOW_MODEL;
    if (!process.env.FIREWORKS_API_KEY) {
      console.error(
        "FIREWORKS_API_KEY absent — cannot run a --provider fireworks shadow " +
          "replay. Aborting.",
      );
      process.exit(1);
    }
    try {
      await preflightInstrumentSelfTest();
    } catch (e) {
      console.error(
        `${(e as Error).message}\n` +
          "Refusing to run: a failing self-test means any rows written would " +
          "record OUR bug as the model's verdict. Zero rows written.",
      );
      process.exit(1);
    }
  } else if (SHADOW_PROVIDER === "codex") {
    SHADOW_MODEL = process.env.PRAXIS_SHADOW_OPENAI_MODEL || "gpt-5.5";
    process.env.PRAXIS_SHADOW_PROVIDER = "codex";
    if (!getCodexClient()) {
      console.error(
        "CODEX_ACCESS_TOKEN absent — cannot run a --provider codex shadow " +
          "replay. Aborting.",
      );
      process.exit(1);
    }
  } else {
    SHADOW_MODEL = process.env.PRAXIS_SHADOW_OPENAI_MODEL || "gpt-5.5";
    process.env.PRAXIS_SHADOW_PROVIDER = "openai";
    if (!getOpenAi()) {
      console.error("OPENAI_API_KEY absent — cannot run shadow replay. Aborting.");
      process.exit(1);
    }
  }

  const rows = await selectSources(args);
  if (rows.length === 0) {
    console.log("no matching source runs (success, allowlisted tenant, with prompt_snapshot).");
    return;
  }
  console.log(`replaying ${rows.length} run(s) on ${SHADOW_PROVIDER}/${SHADOW_MODEL} for tenant ${args.tenant}...`);
  for (const row of rows) {
    try {
      console.log(await replayOne(row, args.tenant));
    } catch (e) {
      if (e instanceof HarnessFailure) {
        console.error(
          `\nHARNESS FAILURE on ${row.id}: ${e.message}\n` +
            `Aborting the batch. Rows written before this point are valid ` +
            `(each carries harness_sha=${harnessSha().slice(0, 12)}); this row ` +
            `and all remaining rows were NOT written. Fix the harness and re-run.`,
        );
        process.exit(1);
      }
      console.log(`FAIL ${row.id}: ${(e as Error).message}`);
    }
  }
}

if (process.argv[1] && /shadow-replay\.(ts|js)$/.test(process.argv[1])) {
  void main();
}
