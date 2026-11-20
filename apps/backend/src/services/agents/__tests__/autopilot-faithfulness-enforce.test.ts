
import { describe, it, expect, vi } from "vitest";
import {
  isAutopilotClassRun,
  autopilotStageOf,
  AUTOPILOT_ELIGIBLE_CLASSES,
  AUTOPILOT_ENFORCED_FLAG,
} from "../autopilot-decision-class";
import { runGroundingChecks, hasHardGroundingFlag } from "../eval/grounding-checks";
import { mapChildStatus } from "../conductor-driver";
import {
  conductorTick,
  type ConductorRow,
  type ConductorNode,
  type ConductorTickDeps,
  type ChildTerminalStatus,
} from "../conductor";
import { scoreInjection } from "../injection-eval/runner";
import { PROBES } from "../injection-eval/probes";
import { AGENT_DISPATCH_STAGES, DECISION_CLASS } from "../autopilot-pipeline-contract";

describe("isAutopilotClassRun", () => {
  it("is TRUE for every autopilot pipeline stage payload", () => {
    for (const stage of AGENT_DISPATCH_STAGES) {
      expect(isAutopilotClassRun({ stage })).toBe(true);
      expect(autopilotStageOf({ stage })).toBe(stage);
    }
  });

  it("is TRUE for an autopilot provisioning decision_class", () => {
    expect(isAutopilotClassRun({ decision_class: DECISION_CLASS.PROVISION_REPO })).toBe(true);
    expect(isAutopilotClassRun({ decision_class: DECISION_CLASS.PROVISION_HOSTING })).toBe(true);
    expect(isAutopilotClassRun({ decision_class: DECISION_CLASS.PROVISION_DOMAIN })).toBe(true);
    expect(isAutopilotClassRun({ decision_class: DECISION_CLASS.PROVISION_EMAIL })).toBe(true);
  });

  it("EXCLUDES the held E3 stripe.* money-path classes (never auto-dispatched)", () => {
    expect(isAutopilotClassRun({ decision_class: DECISION_CLASS.STRIPE_CHECKOUT })).toBe(false);
    expect(
      isAutopilotClassRun({ decision_class: DECISION_CLASS.STRIPE_CREATE_CONNECTED_ACCOUNT }),
    ).toBe(false);
  });

  it("is FALSE for everyday-fleet payloads (chat/cron/slack/handoff)", () => {
    expect(isAutopilotClassRun(undefined)).toBe(false);
    expect(isAutopilotClassRun(null)).toBe(false);
    expect(isAutopilotClassRun("a string")).toBe(false);
    expect(isAutopilotClassRun(42)).toBe(false);
    expect(isAutopilotClassRun({})).toBe(false);
    expect(isAutopilotClassRun({ thread_id: "abc", task: "fix bug" })).toBe(false);
    expect(isAutopilotClassRun({ stage: "deploy" })).toBe(false);
    expect(isAutopilotClassRun({ decision_class: "agent.run" })).toBe(false);
  });

  it("fails SAFE on a hostile/garbage stage field (over-enforce, never under)", () => {
    expect(isAutopilotClassRun({ stage: { nested: "build" } })).toBe(false);
    expect(isAutopilotClassRun({ stage: ["build"] })).toBe(false);
  });

  it("exposes the full eligible-class allowlist for coverage assertions", () => {
    expect(AUTOPILOT_ELIGIBLE_CLASSES).toEqual(
      expect.arrayContaining([...AGENT_DISPATCH_STAGES, DECISION_CLASS.PROVISION_REPO]),
    );
  });
});

const GROUNDING_GATE_AGENTS = new Set([
  "engineer", "performance-marketer", "chief-of-staff", "operator", "pm", "qa",
  "growth-lead", "dispute-response", "support-lead", "research",
]);

function gateDecision(args: {
  agent_slug: string;
  evidence: Parameters<typeof runGroundingChecks>[0]["evidence"];
  agent_output: string;
  runPayload: unknown;
}): { needs_review: boolean; enforced: boolean } {
  const grounding = runGroundingChecks({
    evidence: args.evidence,
    agent_output: args.agent_output,
    agentSlug: args.agent_slug,
  });
  const hard = hasHardGroundingFlag(grounding);
  let needs_review = false;
  let enforced = false;
  if (hard && GROUNDING_GATE_AGENTS.has(args.agent_slug)) needs_review = true;
  if (hard && args.runPayload !== undefined && isAutopilotClassRun(args.runPayload)) {
    needs_review = true;
    enforced = true;
  }
  return { needs_review, enforced };
}

const HARD_FLAG_OUTPUT = "The bug is at server.ts:2408 — fixed.";
const NO_READ_EVIDENCE: Parameters<typeof runGroundingChecks>[0]["evidence"] = [
  { name: "list_files", status: "ok", input: '{"path":"src"}', output: "server.ts" },
];

describe("faithfulness gate — ENFORCE for autopilot, ANNOTATE-only otherwise", () => {
  it("a hard flag produces a HARD grounding flag (precondition)", () => {
    const g = runGroundingChecks({ evidence: NO_READ_EVIDENCE, agent_output: HARD_FLAG_OUTPUT });
    expect(hasHardGroundingFlag(g)).toBe(true);
  });

  it("ENFORCES on an autopilot BUILD stage run by a NON-calibrated agent (company-founder)", () => {
    const d = gateDecision({
      agent_slug: "company-founder",
      evidence: NO_READ_EVIDENCE,
      agent_output: HARD_FLAG_OUTPUT,
      runPayload: { stage: "build", idea: "x" },
    });
    expect(d.needs_review).toBe(true);
    expect(d.enforced).toBe(true);
  });

  it("ENFORCES on an autopilot provisioning decision_class run", () => {
    const d = gateDecision({
      agent_slug: "company-founder",
      evidence: NO_READ_EVIDENCE,
      agent_output: HARD_FLAG_OUTPUT,
      runPayload: { decision_class: DECISION_CLASS.PROVISION_REPO },
    });
    expect(d.needs_review).toBe(true);
    expect(d.enforced).toBe(true);
  });

  it("does NOT enforce (annotate-only) on a NON-autopilot run with the SAME hard flag", () => {
    const d = gateDecision({
      agent_slug: "engineer",
      evidence: NO_READ_EVIDENCE,
      agent_output: HARD_FLAG_OUTPUT,
      runPayload: { thread_id: "t1", task: "fix" },
    });
    expect(d.needs_review).toBe(true);
    expect(d.enforced).toBe(false);
  });

  it("a NON-calibrated, NON-autopilot run with a hard flag is neither flagged-for-review nor enforced", () => {
    const d = gateDecision({
      agent_slug: "company-founder",
      evidence: NO_READ_EVIDENCE,
      agent_output: HARD_FLAG_OUTPUT,
      runPayload: { thread_id: "t1" },
    });
    expect(d.needs_review).toBe(false);
    expect(d.enforced).toBe(false);
  });

  it("a CLEAN autopilot run (no hard flag) is NOT enforced", () => {
    const d = gateDecision({
      agent_slug: "company-founder",
      evidence: [{ name: "view", status: "ok", input: '{"path":"server.ts","view_range":[2400,2410]}', output: "code" }],
      agent_output: "Looked at server.ts:2408 — all good.",
      runPayload: { stage: "build" },
    });
    expect(d.enforced).toBe(false);
    expect(d.needs_review).toBe(false);
  });

  it("the enforced marker flag is a hard-severity pattern", () => {
    expect(AUTOPILOT_ENFORCED_FLAG.severity).toBe("hard");
    expect(AUTOPILOT_ENFORCED_FLAG.pattern).toBe("autopilot_grounding_enforced");
  });
});

describe("mapChildStatus — needs_review on autopilot → held", () => {
  it("success + needs_review + autopilot payload → held", () => {
    expect(
      mapChildStatus("success", { needs_review: true, payload: { stage: "build" } }),
    ).toBe("held");
  });

  it("success + needs_review + NON-autopilot payload → success (annotate-only)", () => {
    expect(
      mapChildStatus("success", { needs_review: true, payload: { thread_id: "t1" } }),
    ).toBe("success");
  });

  it("success WITHOUT needs_review on an autopilot payload → success", () => {
    expect(
      mapChildStatus("success", { needs_review: false, payload: { stage: "build" } }),
    ).toBe("success");
  });

  it("a failed run is failed regardless of needs_review/payload", () => {
    expect(mapChildStatus("failed", { needs_review: true, payload: { stage: "build" } })).toBe(
      "failed",
    );
  });

  it("back-compat: status-only call is unchanged", () => {
    expect(mapChildStatus("success")).toBe("success");
    expect(mapChildStatus("running")).toBe("running");
  });
});

function node(over: Partial<ConductorNode> & { id: string }): ConductorNode {
  return { status: "pending", target_agent_slug: "engineer", payload: { stage: "build" }, estimate_usd: 1, child_run_id: null, ...over };
}
function row(over: Partial<ConductorRow> & { goal_graph: ConductorNode[] }): ConductorRow {
  return { id: "cond-1", tenant_id: "t1", objective: "build app", status: "active", max_usd: 100, spend_usd: 0, ...over };
}
function makeDeps(opts: { row: ConductorRow; childStatuses: Record<string, ChildTerminalStatus> }) {
  const deps: ConductorTickDeps = {
    load: vi.fn(async () => opts.row),
    childStatus: vi.fn(async (id: string) => opts.childStatuses[id] ?? "running"),
    consumeBudget: vi.fn(async () => "charged" as const),
    dispatch: vi.fn(async () => ({ ok: true as const, child_run_id: "child-x" })),
    saveGraph: vi.fn(async () => {}),
    setStatus: vi.fn(async () => {}),
  };
  return deps;
}

describe("conductorTick — held child blocks the pipeline", () => {
  it("a held child HOLDS the run (waiting) — does not advance to the next stage, does not fail", async () => {
    const deps = makeDeps({
      row: row({
        goal_graph: [
          node({ id: "build", status: "dispatched", child_run_id: "c1" }),
          node({ id: "qa", status: "pending" }),
        ],
      }),
      childStatuses: { c1: "held" },
    });
    const r = await conductorTick("cond-1", deps);
    expect(r).toEqual({ action: "waiting", in_flight: 1 });
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.consumeBudget).not.toHaveBeenCalled();
    expect(deps.setStatus).not.toHaveBeenCalled();
  });

  it("once the hold clears (success), the pipeline resumes — next stage dispatches", async () => {
    const deps = makeDeps({
      row: row({
        goal_graph: [
          node({ id: "build", status: "dispatched", child_run_id: "c1" }),
          node({ id: "qa", status: "pending" }),
        ],
      }),
      childStatuses: { c1: "success" },
    });
    const r = await conductorTick("cond-1", deps);
    expect(r).toMatchObject({ action: "dispatched", node_id: "qa" });
    expect(deps.dispatch).toHaveBeenCalledOnce();
  });
});

describe("injection eval — autopilot-stage coverage", () => {
  it("has at least one probe per autopilot pipeline stage", () => {
    const covered = new Set(PROBES.filter((p) => p.autopilot_stage).map((p) => p.autopilot_stage));
    for (const stage of AGENT_DISPATCH_STAGES) {
      expect(covered.has(stage)).toBe(true);
    }
  });

  it("scores 100% with the coverage gate counted (no break-out across any stage)", () => {
    const report = scoreInjection();
    expect(report.failures).toEqual([]);
    expect(report.accuracy).toBe(1);
    expect(report.total).toBe(PROBES.length + 2);
    expect(report.passed).toBe(report.total);
  });
});
