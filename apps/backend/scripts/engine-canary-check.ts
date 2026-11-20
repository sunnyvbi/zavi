#!/usr/bin/env tsx

import { execFileSync } from "node:child_process";
import { serviceClient } from "../src/services/supabase";
import { MODELS } from "../src/services/llm/models";
import {
  aggregateScorecard,
  type AgentScore,
  type GradeOutcome,
} from "./shadow-grade";
import {
  SHADOW_CANARY_AGENTS,
  isShadowCanaryAgent,
  isShadowCanaryConversationalExcluded,
} from "../src/services/eval/engine-parity/shadow-canary-agents";

const DOGFOOD_TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";

export const PARITY_FLOOR = 3;
export const DEFAULT_AGENT_THRESHOLDS: Readonly<Record<string, number>> = {
  research: 0.8,
  "growth-lead": 0.75,
  "performance-marketer": 0.75,
};
export const DEFAULT_THRESHOLD = 0.75;

export function thresholdForAgent(
  agent: string,
  overrides: Readonly<Record<string, number>> = DEFAULT_AGENT_THRESHOLDS,
): number {
  const t = overrides[(agent ?? "").trim()];
  return typeof t === "number" ? t : DEFAULT_THRESHOLD;
}

export type CanaryVerdict = {
  agent_slug: string;
  pass: boolean;
  reason: string;
  parity: number;
  threshold: number;
  graded: number;
  judge_unavailable: number;
  score: AgentScore | null;
};

export function evaluateCanary(
  agent_slug: string,
  score: AgentScore | null,
  threshold: number,
): CanaryVerdict {
  const graded = score?.n ?? 0;
  const judgeUnavail = score?.judge_unavailable ?? 0;
  const parity = score ? score.parity_pct / 100 : 0;
  const base = { agent_slug, parity, threshold, graded, judge_unavailable: judgeUnavail, score };

  if (judgeUnavail > 0) {
    return {
      ...base,
      pass: false,
      reason: `FAIL — ${judgeUnavail} judge_unavailable row(s); a partial/blind grade cannot certify a switch (no --allow-partial).`,
    };
  }
  if (graded === 0) {
    return {
      ...base,
      pass: false,
      reason: "FAIL — zero graded rows; nothing to certify (replay produced no gradeable shadow rows).",
    };
  }
  if (parity < threshold) {
    return {
      ...base,
      pass: false,
      reason: `FAIL — parity ${(parity * 100).toFixed(0)}% < threshold ${(threshold * 100).toFixed(0)}% (graded ${graded}).`,
    };
  }
  return {
    ...base,
    pass: true,
    reason: `PASS — parity ${(parity * 100).toFixed(0)}% >= threshold ${(threshold * 100).toFixed(0)}% (graded ${graded}).`,
  };
}

export function rollbackCommand(tenant_id: string, agent_slug: string): string {
  return [
    "ROLLBACK — undo this flip with either lever:",
    "",
    "  (1) Per-agent revert (clears just this override row → agent default):",
    `      curl -X DELETE https://api.zaviagent.com/api/admin/engine-override \\`,
    `        -H "Authorization: Bearer $STAFF_TOKEN" -H 'Content-Type: application/json' \\`,
    `        -d '{"tenant_id":"${tenant_id}","agent_slug":"${agent_slug}"}'`,
    "",
    "  (2) Fleet-wide master-kill (ignores ALL overrides in one flag flip, no row deletes):",
    `      curl -X POST https://api.zaviagent.com/api/admin/engine-override/master-kill \\`,
    `        -H "Authorization: Bearer $STAFF_TOKEN" -H 'Content-Type: application/json' \\`,
    `        -d '{"provider_overrides_disabled":true}'`,
  ].join("\n");
}

export type CanaryArgs = {
  agent: string;
  provider: "bedrock";
  tenant: string;
  limit: number;
  threshold?: number;
};

export function parseCanaryArgs(argv: string[]): CanaryArgs {
  let agent = "";
  let provider = "bedrock";
  let tenant = DOGFOOD_TENANT;
  let limit = 20;
  let threshold: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--allow-partial") {
      throw new Error(
        "--allow-partial is NOT supported by engine-canary-check: a partial or " +
          "blind grade cannot certify a provider switch. Re-run when the judge is " +
          "available and ALL rows grade.",
      );
    } else if (a === "--agent") agent = argv[++i] ?? "";
    else if (a === "--provider") provider = argv[++i] ?? "";
    else if (a === "--tenant") tenant = argv[++i] ?? "";
    else if (a === "--limit") limit = Math.max(1, Number(argv[++i]) || 20);
    else if (a === "--threshold") {
      const t = Number(argv[++i]);
      if (Number.isFinite(t) && t >= 0 && t <= 1) threshold = t;
      else throw new Error("--threshold must be a number in [0, 1] (parity share).");
    }
  }

  agent = agent.trim();
  if (!agent) throw new Error("--agent <slug> is required.");
  if (provider !== "bedrock") {
    throw new Error(
      `--provider must be "bedrock" (the only candidate this gate certifies). Got "${provider}".`,
    );
  }
  if (isShadowCanaryConversationalExcluded(agent)) {
    throw new Error(
      `agent "${agent}" is conversational; Bedrock has no stateless session resume yet, ` +
        `so it cannot be canaried. Eligible stateless agents: ${[...SHADOW_CANARY_AGENTS].join(", ")}.`,
    );
  }
  if (!isShadowCanaryAgent(agent)) {
    throw new Error(
      `agent "${agent}" is not in the stateless canary set. Eligible: ` +
        `${[...SHADOW_CANARY_AGENTS].join(", ")}.`,
    );
  }
  return { agent, provider: "bedrock", tenant, limit, threshold };
}

function runReplayAndGrade(args: CanaryArgs): void {
  const dist = process.env.PRAXIS_DIST_DIR || "dist";
  const node = process.execPath;
  const common = ["-r", "tsconfig-paths/register"];
  execFileSync(
    node,
    [
      ...common,
      `${dist}/scripts/shadow-replay.js`,
      "--agent",
      args.agent,
      "--provider",
      args.provider,
      "--limit",
      String(args.limit),
    ],
    { stdio: "inherit", timeout: 30 * 60_000 },
  );
  execFileSync(
    node,
    [
      ...common,
      `${dist}/scripts/shadow-grade.js`,
      "--agent",
      args.agent,
      "--provider",
      args.provider,
      "--limit",
      String(args.limit),
    ],
    { stdio: "inherit", timeout: 30 * 60_000 },
  );
}

async function readGradedOutcomes(args: CanaryArgs): Promise<GradeOutcome[]> {
  const sb = serviceClient();
  const { data, error } = await sb
    .from("agent_shadow_runs")
    .select("agent_slug, comparison_score, agent_runs!inner(tenant_id)")
    .eq("agent_slug", args.agent)
    .eq("provider", args.provider)
    .eq("agent_runs.tenant_id", args.tenant)
    .not("comparison_score", "is", null)
    .order("created_at", { ascending: false })
    .limit(args.limit);
  if (error) throw new Error(`canary read-back failed: ${error.message}`);
  return ((data ?? []) as Array<{ agent_slug: string; comparison_score: number }>).map(
    (r) => ({
      kind: "graded" as const,
      agent_slug: r.agent_slug,
      comparison_score: r.comparison_score,
      openai_score: 0,
      anthropic_score: 0,
    }),
  );
}

async function main(): Promise<void> {
  let args: CanaryArgs;
  try {
    args = parseCanaryArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`engine-canary-check: ${(e as Error).message}`);
    process.exit(2);
    return;
  }

  console.log(
    `engine-canary-check: replaying + grading "${args.agent}" on ${args.provider} ` +
      `(model ${MODELS.bedrock.qwen3Next80b}, tenant ${args.tenant}, limit ${args.limit})...`,
  );

  try {
    runReplayAndGrade(args);
  } catch (e) {
    console.error(
      `\nengine-canary-check: replay/grade failed (${(e as Error).message}).\n` +
        `This is a canary FAIL — do NOT flip the override.`,
    );
    process.exit(1);
    return;
  }

  const outcomes = await readGradedOutcomes(args);
  const scores = aggregateScorecard(outcomes);
  const score = scores.find((s) => s.agent_slug === args.agent) ?? null;
  const threshold = args.threshold ?? thresholdForAgent(args.agent);
  const verdict = evaluateCanary(args.agent, score, threshold);

  console.log("\n──────────────────────────────────────────────────────────────");
  console.log(`CANARY ${verdict.pass ? "PASS ✅" : "FAIL ❌"} — ${args.agent} on ${args.provider}`);
  console.log(`  graded rows:      ${verdict.graded}`);
  console.log(`  parity (>=${PARITY_FLOOR}/4):   ${(verdict.parity * 100).toFixed(0)}%`);
  console.log(`  threshold:        ${(verdict.threshold * 100).toFixed(0)}%`);
  console.log(`  judge_unavailable: ${verdict.judge_unavailable}`);
  console.log(`  ${verdict.reason}`);
  console.log("──────────────────────────────────────────────────────────────");

  if (verdict.pass) {
    console.log(
      `\nTo flip: set the override via POST /api/admin/engine-override ` +
        `{tenant_id:"${args.tenant}", agent_slug:"${args.agent}", provider:"bedrock", ` +
        `model:"${MODELS.bedrock.qwen3Next80b}"}.\n`,
    );
  }
  console.log("\n" + rollbackCommand(args.tenant, args.agent) + "\n");

  process.exit(verdict.pass ? 0 : 1);
}

if (process.argv[1] && /engine-canary-check\.(ts|js)$/.test(process.argv[1])) {
  void main();
}
