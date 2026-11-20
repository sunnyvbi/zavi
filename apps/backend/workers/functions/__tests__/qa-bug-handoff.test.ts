import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildQaBugReport,
  buildEngineerDispatch,
  capKeepingUntrustedClosed,
  QA_BUG_REPORT_CLASS,
  QA_DISPATCH_SPECIALIST_CLASS,
  type FailedTestInput,
} from "../qa-bug-handoff";

const read = (rel: string): string =>
  readFileSync(join(process.cwd(), rel), "utf8");

const baseSpec = {
  steps: [
    "Navigate to https://staging.example.com/signup",
    "Fill the email field with qa@example.com",
    "Click Continue",
  ],
  expected_outcome: "The dashboard loads and shows a welcome banner.",
  preconditions: [],
};

function failedInput(over: Partial<FailedTestInput> = {}): FailedTestInput {
  return {
    test_case_id: "11111111-1111-1111-1111-111111111111",
    test_title: "Signup happy path",
    test_role: "guest",
    nl_spec: baseSpec,
    verdict: {
      test_result: "fail",
      reason: "Continue button stayed disabled; no dashboard navigation.",
      evidence: "https://staging.example.com/signup (screenshot: error banner)",
    },
    consecutive_red: 1,
    run_id: "22222222-2222-2222-2222-222222222222",
    ...over,
  };
}

describe("buildQaBugReport — typed bug artifact", () => {
  it("carries steps, expected-vs-actual, and the evidence/screenshot ref", () => {
    const bug = buildQaBugReport(failedInput());
    expect(bug.test_case_id).toBe("11111111-1111-1111-1111-111111111111");
    expect(bug.steps).toEqual(baseSpec.steps);
    expect(bug.expected_outcome).toBe(baseSpec.expected_outcome);
    expect(bug.actual_observed).toBe(
      "Continue button stayed disabled; no dashboard navigation.",
    );
    expect(bug.artifact_ref).toBe(
      "https://staging.example.com/signup (screenshot: error banner)",
    );
    expect(bug.source_run_id).toBe("22222222-2222-2222-2222-222222222222");
    expect(bug.rendered_markdown).toContain("Expected:");
    expect(bug.rendered_markdown).toContain("Actual:");
    expect(bug.rendered_markdown).toContain("Evidence:");
  });

  it("classifies a first red as NEW (consecutive_red=1)", () => {
    const bug = buildQaBugReport(failedInput({ consecutive_red: 1 }));
    expect(bug.classification).toBe("new");
    expect(bug.consecutive_red).toBe(1);
    expect(bug.rendered_markdown).toContain("NEW failure");
  });

  it("classifies a repeated red as PERSISTENT (consecutive_red>=2)", () => {
    const bug = buildQaBugReport(failedInput({ consecutive_red: 3 }));
    expect(bug.classification).toBe("persistent");
    expect(bug.consecutive_red).toBe(3);
    expect(bug.rendered_markdown).toContain("PERSISTENT");
    expect(bug.rendered_markdown).toContain("3 runs");
  });

  it("artifact_ref is null when the verdict carried no evidence", () => {
    const bug = buildQaBugReport(
      failedInput({
        verdict: { test_result: "fail", reason: "page 500'd" },
      }),
    );
    expect(bug.artifact_ref).toBeNull();
    expect(bug.rendered_markdown).not.toContain("Evidence:");
  });

  it("falls back gracefully on a malformed / empty nl_spec", () => {
    const bug = buildQaBugReport(failedInput({ nl_spec: null }));
    expect(bug.steps).toEqual([]);
    expect(bug.expected_outcome).toBe("");
    expect(bug.actual_observed).toBeTruthy();
  });

  it("the class constant is qa.bug-report", () => {
    expect(QA_BUG_REPORT_CLASS).toBe("qa.bug-report");
  });
});

describe("buildEngineerDispatch — approval-gated fix offer", () => {
  it("targets engineer, carries repro intent, and pairs the bug decision id", () => {
    const bug = buildQaBugReport(failedInput({ consecutive_red: 4 }));
    const dispatch = buildEngineerDispatch(
      bug,
      "acme/web",
      "33333333-3333-3333-3333-333333333333",
    );
    expect(dispatch.target_agent_slug).toBe("engineer");
    expect(dispatch.dispatched_by).toBe("qa");
    expect(dispatch.origin_decision_id).toBe(
      "33333333-3333-3333-3333-333333333333",
    );
    expect(dispatch.intent).toContain("acme/web");
    expect(dispatch.intent).toContain("Repro steps:");
    expect(dispatch.intent).toContain("Expected:");
    expect(dispatch.intent).toContain("Actual:");
    expect(dispatch.intent).toContain("4 runs in a row");
    expect(dispatch.intent.length).toBeLessThanOrEqual(2000);
  });

  it("long repro steps never cut off the </untrusted_web_content> closing tag", () => {
    const bug = {
      ...buildQaBugReport(failedInput()),
      steps: Array.from({ length: 30 }, (_, i) => `Step ${i} ${"x".repeat(40)}`),
      actual_observed: `<untrusted_web_content>${"page said ".repeat(200)}</untrusted_web_content>`,
    };
    const { intent } = buildEngineerDispatch(bug, "acme/web");
    expect(intent.length).toBeLessThanOrEqual(2000);
    const open = intent.lastIndexOf("<untrusted_web_content>");
    expect(open).toBeGreaterThan(-1);
    expect(intent.lastIndexOf("</untrusted_web_content>")).toBeGreaterThan(open);
    expect(intent.endsWith("</untrusted_web_content>")).toBe(true);
  });

  it("capKeepingUntrustedClosed drops a half-cut opening tag and leaves closed text alone", () => {
    expect(capKeepingUntrustedClosed("abc <untrusted_web_content>", 12)).toBe("abc ");
    expect(capKeepingUntrustedClosed("short", 2000)).toBe("short");
  });

  it("carries the resolved site and repo identity into the QA approval card", () => {
    const bug = buildQaBugReport(failedInput());
    const card = buildEngineerDispatch(bug, "Praxis-build/site", undefined, "site-1");
    expect(card.repo_hint).toBe("Praxis-build/site");
    expect(card.site_id).toBe("site-1");
  });

  it("the dispatch class constant routes to the existing dispatch handler", () => {
    expect(QA_DISPATCH_SPECIALIST_CLASS).toBe("qa.dispatch-specialist");
  });
});

describe("qa-weekly-execute worker — bug-handoff wiring", () => {
  const src = read("workers/functions/qa-weekly-execute.ts");

  it("only FAILED verdicts enter the bug-handoff loop", () => {
    expect(src).toMatch(
      /results\.filter\(\s*\n?\s*\(r\) => r\.verdict\.test_result === "fail" && r\.test_case_id,?\s*\n?\s*\)/,
    );
  });

  it("records the outcome (maintains consecutive_red) BEFORE building the bug", () => {
    expect(src).toMatch(/qaRecordTestOutcome\(/);
    expect(src).toMatch(/status: "failed"/);
    expect(src).toMatch(/consecutive_red: outcome\.consecutive_red/);
  });

  it("emits the typed qa.bug-report decision per failed test", () => {
    expect(src).toMatch(/p_decision_class: QA_BUG_REPORT_CLASS/);
    expect(src).toMatch(/buildQaBugReport\(/);
  });

  it("the engineer dispatch is repo-GATED — bug-only when the tenant has no repo", () => {
    expect(src).toMatch(/repoTarget = await resolveNamedEngineerRepo\(tid\)/);
    expect(src).toMatch(/repoFullName = repoTarget\?\.repo \?\? null/);
    expect(src).toMatch(/if \(repoFullName\) \{[\s\S]*?QA_DISPATCH_SPECIALIST_CLASS/);
  });

  it("DEFAULT is file-not-fix — NO engineer run is enqueued by the worker", () => {
    const handoffStart = src.indexOf("P1-4 bug-handoff — typed bug artifact");
    expect(handoffStart).toBeGreaterThan(-1);
    const handoffEnd = src.indexOf("P1-d: return", handoffStart);
    expect(handoffEnd).toBeGreaterThan(handoffStart);
    const handoffBlock = src.slice(handoffStart, handoffEnd);
    expect(handoffBlock).not.toContain("enqueueAgentRun");
  });

  it("the dispatch body targets engineer + is approval-gated (no auto autonomy in body)", () => {
    expect(src).toMatch(/buildEngineerDispatch\(/);
    expect(src).toMatch(/QA_DISPATCH_SPECIALIST_CLASS,\s*\n?\s*p_body: dispatch/);
  });
});

describe("qa bug-handoff — decision-class migration", () => {
  const mig = read(
    "../../supabase/migrations/20260611131329_qa_bug_handoff_decision_classes.sql",
  );

  it("seeds qa.bug-report as a proposal-only (null handler) approval class", () => {
    expect(mig).toMatch(/'qa\.bug-report',[\s\S]*?'approval',\s*\n?\s*null/);
  });

  it("seeds qa.dispatch-specialist routed to the existing praxis.dispatch_specialist handler", () => {
    expect(mig).toMatch(
      /'qa\.dispatch-specialist',[\s\S]*?'approval',\s*\n?\s*'praxis\.dispatch_specialist'/,
    );
  });

  it("is idempotent (on conflict do nothing)", () => {
    expect(mig).toMatch(/on conflict \(slug\) do nothing/);
  });
});
