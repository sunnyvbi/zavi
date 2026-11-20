#!/usr/bin/env tsx
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { parse as parseEnv } from "dotenv";
import type { ReviewTiming } from "../src/agents/cgo/plan-review";

function arg(key: string, fallback: string): string {
  const index = process.argv.indexOf(`--${key}`);
  return index < 0 ? fallback : process.argv[index + 1] ?? fallback;
}

async function main() {
  for (const key of Object.keys(process.env)) {
    if (/SUPABASE|DATABASE_URL|POSTGRES|INNGEST/i.test(key)) delete process.env[key];
  }
  const { STRATEGY_REVIEW_CASES } = await import("../src/services/eval/growth-sim/strategy-review-cases");
  if (!process.argv.includes("--live")) {
    console.log("No models called. Add --live for paid replay. Cases:");
    console.log(STRATEGY_REVIEW_CASES.map(c => `${c.id}: ${c.description}`).join("\n"));
    return;
  }
  const fixture = STRATEGY_REVIEW_CASES.find(c => c.id === arg("case", "missing-check-date"));
  if (!fixture) throw new Error("Unknown case; run without --live to list cases.");
  const k = Number(arg("k", "1"));
  if (!Number.isInteger(k) || k < 1 || k > 3) throw new Error("--k must be 1, 2 or 3; each repeat runs both modes.");
  const credentials = parseEnv(readFileSync(resolve(__dirname, "../.env")));
  for (const key of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKENS", "OPENAI_API_KEY", "FIREWORKS_API_KEY", "CRITIC_FAMILY", "OPENAI_CRITIC_MODEL"]) {
    if (!process.env[key] && credentials[key]) process.env[key] = credentials[key];
  }
  const { reviewAndRevisePlan, buildDossier, structuralIssuesFor, createPlanReviewDeps, parseCritique, CRITIC_SYSTEM } = await import("../src/agents/cgo/plan-review");
  const { loadGlobalAgentDefinition } = await import("../src/services/agents/registry");
  const { agentDefaultEffort } = await import("../src/services/agents/engineer-cost-v2");
  const { resolveCriticFamily } = await import("../src/services/critic/critic-model");
  const model = loadGlobalAgentDefinition("cgo")?.metadata_praxis?.model;
  if (!model) throw new Error("Cannot identify CGO model; refusing an incomparable replay.");
  const reviewer = arg("reviewer", "configured");
  if (!["configured", "codex-session"].includes(reviewer)) throw new Error("Unknown reviewer");
  const config = { model, effort: agentDefaultEffort("cgo", model), criticFamily: reviewer === "codex-session" ? "codex-session" : await resolveCriticFamily() };
  const outDir = resolve(arg("out", "/tmp/cgo-strategy-review-eval"));
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const rows: unknown[] = [];
  const blind: unknown[] = [];
  const key: unknown[] = [];
  for (let repeat = 0; repeat < k; repeat++) {
    const modes = repeat % 2 ? ["targeted", "full"] as const : ["full", "targeted"] as const;
    for (const revisionMode of modes) {
      const timings: ReviewTiming[] = [];
      const debugDir = resolve(outDir, `${revisionMode}-${repeat + 1}`);
      mkdirSync(debugDir, { recursive: true, mode: 0o700 });
      process.env.CGO_PLAN_REVIEW_DEBUG_DIR = debugDir;
      console.log(`Starting ${fixture.id} repeat ${repeat + 1} ${revisionMode}`);
      const start = Date.now();
      const deps = createPlanReviewDeps();
      if (reviewer === "codex-session") {
        deps.critique = async ({ strategy, dossier, structuralIssues, signal }) => {
          const id = randomUUID();
          const request = resolve(outDir, `${id}.request.json`);
          const response = resolve(outDir, `${id}.response.json`);
          writeFileSync(request, JSON.stringify({ rubric: CRITIC_SYSTEM, strategy, dossier, structuralIssues }, null, 2), { mode: 0o600 });
          console.log(`CODEX_REVIEW_REQUEST ${request}`);
          while (!signal.aborted) {
            if (existsSync(response)) return parseCritique(readFileSync(response, "utf8"));
            await delay(250, undefined, { signal });
          }
          throw new Error("Codex session review deadline");
        };
      }
      const result = await reviewAndRevisePlan({ ...structuredClone(fixture), revisionMode,
        onTiming: event => { timings.push(event); console.log(JSON.stringify(event)); },
      }, deps);
      const remainingIssues = structuralIssuesFor(result.strategy, buildDossier(fixture.payload, fixture.tools));
      const primaryUnavailable = timings.some(t => t.stage === "critic_primary" && t.outcome !== "ok");
      const row = { case: fixture.id, repeat, revisionMode, config, elapsed_ms: Date.now() - start,
        primary_available: !primaryUnavailable, remaining_issues: remainingIssues, result, timings };
      rows.push(row);
      const label = randomUUID();
      blind.push({ label, case: fixture.id, evidence: fixture.payload, strategy: result.strategy });
      key.push({ label, revisionMode, repeat });
      writeFileSync(resolve(outDir, "results.json"), JSON.stringify(rows, null, 2), { mode: 0o600 });
      writeFileSync(resolve(outDir, "blind-review.json"), JSON.stringify([...blind].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), null, 2), { mode: 0o600 });
      writeFileSync(resolve(outDir, "review-key.json"), JSON.stringify(key, null, 2), { mode: 0o600 });
      console.log(`Finished ${revisionMode}: ${result.stopped}; remaining code findings=${remainingIssues.length}`);
      if (primaryUnavailable) {
        console.log("Inconclusive: primary reviewer unavailable. Stopping paid comparisons; restore its configuration before repeating.");
        process.exitCode = 2;
        return;
      }
    }
  }
  console.log(`Wrote ${rows.length} outputs to ${outDir}. Human comparison and broader cases are still required; this script never enables the feature.`);
}

main().catch(() => { console.error("Strategy replay failed; no rollout decision was made."); process.exitCode = 1; });
