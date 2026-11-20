
import type { EvalReport, EvalCaseResult } from "@/services/evals/types";
import {
  escape_for_prompt,
  renderUntrustedBlock,
  renderUntrustedBlockWithAttrs,
  renderUntrustedFeedback,
} from "@/services/agents/prompt-injection";
import { PROBES, CONTROL_RAW, type InjectionProbe, type AutopilotStage } from "./probes";
import { AGENT_DISPATCH_STAGES } from "@/services/agents/autopilot-pipeline-contract";

const LIVE_CLOSE_TAG = /<\/[a-z_][a-z0-9_-]*\s*>/i;
const LIVE_FENCE = /```/;
const UNPREFIXED_ROLE = /^(system|assistant|user|tool|developer)\s*:/i;

export function hasBreakoutVector(body: string): { breakout: boolean; reason: string | null } {
  if (LIVE_CLOSE_TAG.test(body)) return { breakout: true, reason: "live close-tag survived escaping" };
  if (LIVE_FENCE.test(body)) return { breakout: true, reason: "live triple-backtick survived escaping" };
  for (const line of body.split("\n")) {
    if (UNPREFIXED_ROLE.test(line)) {
      return { breakout: true, reason: `un-prefixed role header survived: ${line.slice(0, 40)}` };
    }
  }
  return { breakout: false, reason: null };
}

function renderProbe(p: InjectionProbe): string {
  switch (p.path) {
    case "tool_output":
      return renderUntrustedBlock("tool_output", p.payload);
    case "web_page":
      return renderUntrustedBlock("web_page", p.payload);
    case "memory_extract":
      return renderUntrustedBlockWithAttrs("memory_note", { note_id: "probe" }, p.payload);
    case "operator_feedback":
      return renderUntrustedFeedback([{ rating: 1, comment: p.payload, source: "operator" }]);
  }
}

const EXPECTED_WRAPPER: Record<InjectionProbe["path"], string> = {
  tool_output: "<untrusted_tool_output>",
  web_page: "<untrusted_web_page>",
  memory_extract: "<untrusted_memory_note",
  operator_feedback: "<untrusted_operator_feedback>",
};

export function scoreInjection(): EvalReport {
  const failures: EvalCaseResult[] = [];
  let passed = 0;

  for (const p of PROBES) {
    const escaped = escape_for_prompt(p.payload);
    const bk = hasBreakoutVector(escaped);
    const rendered = renderProbe(p);
    const wrapped = rendered.includes(EXPECTED_WRAPPER[p.path]);

    if (!bk.breakout && wrapped) {
      passed += 1;
    } else {
      failures.push({
        case_id: p.id,
        pass: false,
        reason: bk.breakout
          ? `injection NOT neutralized: ${bk.reason}`
          : `payload escaped fine but render missing ${EXPECTED_WRAPPER[p.path]} wrapper`,
        meta: { path: p.path },
      });
    }
  }

  const controlTrips = hasBreakoutVector(CONTROL_RAW).breakout;
  const controlTotal = 1;
  if (!controlTrips) {
    failures.push({
      case_id: "control-detector-fires",
      pass: false,
      reason: "control raw break-out string did NOT trip the detector — detector is a no-op, suite cannot fail",
      meta: { control: true },
    });
  }

  const coveredStages = new Set<AutopilotStage>();
  for (const p of PROBES) if (p.autopilot_stage) coveredStages.add(p.autopilot_stage);
  const coverageTotal = 1;
  const missingStages = AGENT_DISPATCH_STAGES.filter((s) => !coveredStages.has(s as AutopilotStage));
  const coverageOk = missingStages.length === 0;
  if (!coverageOk) {
    failures.push({
      case_id: "autopilot-stage-coverage",
      pass: false,
      reason: `injection corpus missing autopilot-stage coverage for: ${missingStages.join(", ")} — every ENFORCE-gated stage needs a probe`,
      meta: { missing_stages: missingStages.join(",") },
    });
  }

  const total = PROBES.length + controlTotal + coverageTotal;
  const passedTotal = passed + (controlTrips ? 1 : 0) + (coverageOk ? 1 : 0);
  return {
    slug: "injection-deterministic",
    ts: new Date().toISOString(),
    total,
    passed: passedTotal,
    failed: total - passedTotal,
    accuracy: total > 0 ? passedTotal / total : 0,
    failures,
    blocking_gate: true,
    notes:
      `${PROBES.length} injection probes across tool-output/web/memory/feedback paths ` +
      `(incl. ${PROBES.filter((p) => p.autopilot_stage).length} autopilot-stage probes covering ${AGENT_DISPATCH_STAGES.length} ENFORCE-gated stages) ` +
      `+ 1 detector control + 1 autopilot-stage coverage gate. ` +
      `Pure deterministic (no LLM/tools). Defender-extension to per-path wrappers is a separate gated follow-up.`,
  };
}
