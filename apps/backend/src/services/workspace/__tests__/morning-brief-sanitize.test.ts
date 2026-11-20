
import { describe, it, expect } from "vitest";
import {
  sanitizeBriefForCustomer,
  assertRenderedClean,
} from "../morning-brief-sanitize";
import type { MorningBriefResponse } from "../morning-brief-assembler";

function baseBrief(): MorningBriefResponse {
  return {
    yesterday: {
      builds_started: 0,
      builds_done: 0,
      builds_failed: 0,
      spend_usd: 0,
      pr_count: null,
    },
    today: { proposed_plans: 0, pending_suggestions: 0, pending_approvals: 0 },
    goals: [],
    recent_activity: [],
  };
}

describe("sanitizeBriefForCustomer", () => {
  it("rewrites a Praxis brand leak to Zavi in goal + activity fields", () => {
    const b = baseBrief();
    b.goals = [
      {
        objective: "Ship the Praxis workspace",
        target_metric: "signups",
        current_value: 10,
        target_value: 100,
        status: "active",
      },
    ];
    b.recent_activity = [
      { kind: "build_done", label: "Build done: Praxis dashboard", at: "2026-06-07T00:00:00Z", link: null },
    ];

    const { brief, violations } = sanitizeBriefForCustomer(b);

    const blob = JSON.stringify(brief);
    expect(blob).not.toMatch(/\bPraxis\b/);
    expect(brief.goals[0].objective).toContain("Zavi");
    expect(brief.recent_activity[0].label).toContain("Zavi");
    expect(violations).not.toContain("residual_praxis");
  });

  it("scrubs the growth 'do this first' line (internal marker + brand leak)", () => {
    const b = baseBrief();
    b.growth_do_this_first = "[proposed] Ship the Praxis growth loop";
    const { brief, violations } = sanitizeBriefForCustomer(b);
    expect(brief.growth_do_this_first).toBe("Ship the Zavi growth loop");
    expect(brief.growth_do_this_first).not.toContain("[proposed]");
    expect(JSON.stringify(brief)).not.toMatch(/\bPraxis\b/);
    expect(violations).toContain("internal_marker");
  });

  it("blanks the growth line to null when the scrub empties it", () => {
    const b = baseBrief();
    b.growth_do_this_first = "[proposed]";
    const { brief } = sanitizeBriefForCustomer(b);
    expect(brief.growth_do_this_first).toBeNull();
  });

  it("leaves the payload growth-line-free when the field is absent (byte-identical clean path)", () => {
    const b = baseBrief();
    const { brief } = sanitizeBriefForCustomer(b);
    expect("growth_do_this_first" in brief).toBe(false);
  });

  it("REDACTS (not just flags) a QA-test seed string + null-name token in content", () => {
    const b = baseBrief();
    b.goals = [
      {
        objective: "QA test goal",
        target_metric: "there",
        current_value: 5,
        target_value: 50,
        status: "active",
      },
    ];

    const { brief, violations } = sanitizeBriefForCustomer(b);
    expect(violations).toContain("qa_test_string");
    expect(violations).toContain("null_name_token");
    expect(brief.goals[0].objective).not.toMatch(/qa\s*test/i);
    expect(brief.goals[0].objective).toBe("goal");
    expect(brief.goals[0].target_metric).toBe("");
  });

  it("REDACTION sweep: returned brief has NO 'QA test' / 'Praxis' / lone-'?' anywhere", () => {
    const b = baseBrief();
    b.goals = [
      { objective: "QA test the Praxis launch", target_metric: "?", current_value: 1, target_value: 2, status: "active" },
    ];
    b.recent_activity = [
      { kind: "build_done", label: "Build done: Praxis QA test fixture", at: "2026-06-07T00:00:00Z", link: null },
    ];
    b.top_decisions = [
      { id: "d1", title: "Approve QA test Praxis budget", recommendation: "?", impact: "Praxis impact", risk: "?" },
    ];

    const { brief } = sanitizeBriefForCustomer(b);
    const blob = JSON.stringify(brief);
    expect(blob).not.toMatch(/qa\s*test/i);
    expect(blob).not.toMatch(/\bPraxis\b/);
    expect(brief.goals[0].target_metric).toBe("");
    expect(brief.top_decisions![0].recommendation ?? "").toBe("");
    expect(brief.top_decisions![0].risk ?? "").toBe("");
  });

  it("flags a lone-? metric (null current or target value)", () => {
    const b = baseBrief();
    b.goals = [
      {
        objective: "Grow MRR",
        target_metric: "mrr",
        current_value: null,
        target_value: 100,
        status: "active",
      },
    ];

    const { violations } = sanitizeBriefForCustomer(b);
    expect(violations).toContain("lone_question_metric");
  });

  it("does NOT flag legitimate prose that merely contains the word 'there'", () => {
    const b = baseBrief();
    b.goals = [
      {
        objective: "Make sure there is a refund policy",
        target_metric: "refunds",
        current_value: 1,
        target_value: 10,
        status: "active",
      },
    ];
    const { violations } = sanitizeBriefForCustomer(b);
    expect(violations).not.toContain("null_name_token");
  });

  it("returns a clean brief + empty violations for a clean input", () => {
    const b = baseBrief();
    b.goals = [
      {
        objective: "Hit 200 signups",
        target_metric: "signups",
        current_value: 120,
        target_value: 200,
        status: "active",
      },
    ];
    const { violations } = sanitizeBriefForCustomer(b);
    expect(violations).toEqual([]);
  });

  it("scrubs decision card (top_decisions) string fields too", () => {
    const b = baseBrief();
    b.top_decisions = [
      { id: "d1", title: "Approve the Praxis budget", recommendation: "QA test rec", impact: "high", risk: "low" },
    ];
    const { brief, violations } = sanitizeBriefForCustomer(b);
    expect(brief.top_decisions?.[0].title).toContain("Zavi");
    expect(JSON.stringify(brief.top_decisions)).not.toMatch(/\bPraxis\b/);
    expect(violations).toContain("qa_test_string");
  });

  it("strips an internal provenance / build-lane marker and flags internal_marker", () => {
    const b = baseBrief();
    b.recent_activity = [
      { kind: "build_done", label: "Build done: [refine] tweak the footer", at: "2026-06-07T00:00:00Z", link: null },
    ];
    b.top_decisions = [
      { id: "d1", title: "Grow signups [observed]", risk: "low" },
    ];
    const { brief, violations } = sanitizeBriefForCustomer(b);
    expect(violations).toContain("internal_marker");
    expect(brief.recent_activity[0].label).not.toContain("[refine]");
    expect(brief.recent_activity[0].label).toBe("Build done: tweak the footer");
    expect(brief.top_decisions?.[0].title).not.toContain("[observed]");
  });

  it("normalizes an em-dash in agent-authored copy to a comma clause-break", () => {
    const b = baseBrief();
    b.top_decisions = [
      { id: "d1", title: "Reset token reuse — account takeover", risk: "high" },
    ];
    const { brief } = sanitizeBriefForCustomer(b);
    expect(brief.top_decisions?.[0].title).not.toContain("—");
    expect(brief.top_decisions?.[0].title).toBe("Reset token reuse, account takeover");
  });

  it("dedupes violation codes (set semantics, no per-field tally)", () => {
    const b = baseBrief();
    b.goals = [
      { objective: "QA test one", target_metric: "x", current_value: 1, target_value: 2, status: "active" },
      { objective: "QA test two", target_metric: "y", current_value: 1, target_value: 2, status: "active" },
    ];
    const { violations } = sanitizeBriefForCustomer(b);
    expect(violations.filter((v) => v === "qa_test_string")).toHaveLength(1);
  });
});

describe("assertRenderedClean (slice 4 fail-closed guard)", () => {
  it("flags a residual Praxis leak in rendered output", () => {
    const out = assertRenderedClean({
      subject: "Your morning brief",
      html: "<p>Welcome to Praxis</p>",
      text: "Welcome to Praxis",
    });
    expect(out).toContain("residual_praxis");
  });

  it("flags a QA-test seed string in rendered output", () => {
    const out = assertRenderedClean({
      subject: "QA test goal",
      html: "<p>ok</p>",
      text: "ok",
    });
    expect(out).toContain("qa_test_string");
  });

  it("flags 'Good morning there' in the rendered greeting", () => {
    const out = assertRenderedClean({
      subject: "Your morning brief",
      html: "<p>Good morning there. Here is your brief.</p>",
      text: "Good morning there",
    });
    expect(out).toContain("null_name_token");
  });

  it("flags a leaked internal marker in rendered output", () => {
    const out = assertRenderedClean({
      subject: "Your morning brief",
      html: "<li>Your team ran 2 tasks. [observed]</li>",
      text: "Your team ran 2 tasks. [observed]",
    });
    expect(out).toContain("internal_marker");
  });

  it("returns empty for clean rendered output", () => {
    const out = assertRenderedClean({
      subject: "Your morning brief from Zavi",
      html: "<p>Good morning Ravi. Here is your brief.</p>",
      text: "Good morning Ravi.",
    });
    expect(out).toEqual([]);
  });
});
