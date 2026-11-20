
import type { EvalReport } from "./types";
import {
  scoreDeterministic as scoreSlackRoutingDeterministic,
} from "@/services/slack/routing-eval/runner";
import { GOLDENS as slackRoutingGoldens } from "@/services/slack/routing-eval/goldens";
import { scoreInjection } from "@/services/agents/injection-eval/runner";
import { scoreAgentBehaviorGoldens } from "./agent-behavior-detector-stability";
import { scoreReaderLoad } from "@/services/agents/reader-load-eval/runner";
import { checkQuestionBank } from "./operator-db-analytics/bank-integrity";
import { GOLDENS as readerLoadGoldens } from "@/services/agents/reader-load-eval/goldens";

export type EvalCostBucket = "deterministic" | "live_anthropic" | "live_other";

export type EvalEntry = {
  slug: string;
  description: string;
  cost: EvalCostBucket;
  blocking_gate: boolean;
  runner: () => Promise<EvalReport>;
};

const slackRoutingDeterministic: EvalEntry = {
  slug: "slack-routing-deterministic",
  description:
    "Slack-message routing: drives the pure decideSlackRoute over goldens " +
    "with the classifier verdict STUBBED (golden supplies it). Zero LLM " +
    "cost. CI regression gate — asserts 100% on every commit.",
  cost: "deterministic",
  blocking_gate: true,
  runner: async (): Promise<EvalReport> => {
    const report = scoreSlackRoutingDeterministic(slackRoutingGoldens);
    return {
      slug: "slack-routing-deterministic",
      ts: new Date().toISOString(),
      total: report.total,
      passed: report.passed,
      failed: report.total - report.passed,
      accuracy: report.accuracy,
      failures: report.cases
        .filter((c) => !c.pass)
        .map((c) => ({
          case_id: c.name,
          pass: false,
          reason: c.reason ?? `expected ${c.expected}, got ${c.got}`,
          meta: { incident: c.incident ?? null },
        })),
      blocking_gate: true,
      notes:
        report.incidentFailures.length > 0
          ? `${report.incidentFailures.length} incident regressions (permanent-gate goldens)`
          : undefined,
    };
  },
};

const operatorDbAnalyticsBank: EvalEntry = {
  slug: "operator-db-analytics-bank",
  description:
    "Operator-DB analytics question bank integrity: fixtures are deterministic, " +
    "every business shape still has an unanswerable and an ambiguous question, " +
    "no 'known wrong answer' has drifted into agreeing with the right one, and " +
    "the truncation fixtures still exceed the tool's row cap. Zero LLM cost.",
  cost: "deterministic",
  blocking_gate: true,
  runner: async (): Promise<EvalReport> => {
    const { total, findings } = checkQuestionBank();
    return {
      slug: "operator-db-analytics-bank",
      ts: new Date().toISOString(),
      total,
      passed: total - findings.length,
      failed: findings.length,
      accuracy: total === 0 ? 0 : (total - findings.length) / total,
      blocking_gate: true,
      failures: findings.map((f) => ({ case_id: f.case_id, pass: false, reason: f.reason, meta: {} })),
    };
  },
};

const agentBehaviorDetectorStability: EvalEntry = {
  slug: "agent-behavior-detector-stability",
  description:
    "Agent-behavior goldens (task-success/connector-wall/format): validates corpus " +
    "shape and re-runs the deterministic detectors over frozen actual_output, asserting " +
    "the stored verdict reproduces. Protects the golden set + detector logic from silent " +
    "drift. Zero LLM / zero runtime. CI regression gate.",
  cost: "deterministic",
  blocking_gate: true,
  runner: async (): Promise<EvalReport> => scoreAgentBehaviorGoldens(),
};

const injectionDeterministic: EvalEntry = {
  slug: "injection-deterministic",
  description:
    "Adversarial prompt-injection: asserts escape_for_prompt + the untrusted-* " +
    "wrappers neutralize break-out primitives (close-tags, fences, role headers) " +
    "across tool-output/web/memory/feedback probes. Zero LLM/tools — pure escape " +
    "assertion + a detector control. CI regression gate.",
  cost: "deterministic",
  blocking_gate: true,
  runner: async (): Promise<EvalReport> => scoreInjection(),
};

const readerLoadDeterministic: EvalEntry = {
  slug: "reader-load-deterministic",
  description:
    "Reader-load / graspability: asserts a report agent's interactive reply " +
    "LEADS with an answer (first line is prose ≤180 chars, not a header) and " +
    "is not a WALL (≤8 lines before the first section header) over goldens " +
    "anchored by the real perfmarketer 'how are ads doing' turn (run 6812c7a5). " +
    "Zero LLM cost. CI regression gate for the F1 lead-shaper contract.",
  cost: "deterministic",
  blocking_gate: true,
  runner: async (): Promise<EvalReport> => {
    const report = scoreReaderLoad(readerLoadGoldens);
    return {
      slug: "reader-load-deterministic",
      ts: new Date().toISOString(),
      total: report.total,
      passed: report.passed,
      failed: report.total - report.passed,
      accuracy: report.accuracy,
      blocking_gate: true,
      failures: report.cases
        .filter((c) => !c.pass)
        .map((c) => ({
          case_id: c.name,
          pass: false,
          reason: c.reason ?? "graspability mismatch",
          meta: {},
        })),
    };
  },
};

export const EVAL_REGISTRY: readonly EvalEntry[] = [
  agentBehaviorDetectorStability,
  injectionDeterministic,
  operatorDbAnalyticsBank,
  readerLoadDeterministic,
  slackRoutingDeterministic,
];

export function listEvals(): readonly EvalEntry[] {
  return EVAL_REGISTRY;
}

export function findEval(slug: string): EvalEntry | undefined {
  return EVAL_REGISTRY.find((e) => e.slug === slug);
}
