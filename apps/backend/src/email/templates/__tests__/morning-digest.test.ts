
import { describe, it, expect } from "vitest";
import { renderMorningDigestEmail } from "../morning-digest";
import type { MorningBriefResponse } from "../../../services/workspace/morning-brief-assembler";

const OPTS = {
  workspaceUrl: "https://www.zaviagent.com/workspace",
  approvalsUrl: "https://www.zaviagent.com/workspace?tab=channels",
  displayName: "Acme Robotics",
};

function richBrief(over: Partial<MorningBriefResponse> = {}): MorningBriefResponse {
  return {
    yesterday: {
      builds_started: 2,
      builds_done: 1,
      builds_failed: 1,
      spend_usd: 4.2,
      pr_count: 3,
    },
    today: { proposed_plans: 1, pending_suggestions: 2, pending_approvals: 4 },
    goals: [
      {
        objective: "Hit 200 signups",
        target_metric: "signups",
        current_value: 120,
        target_value: 200,
        status: "active",
      },
    ],
    recent_activity: [
      { kind: "build_done", label: "Build done: landing page", at: "2026-06-06T01:00:00Z", link: "/workspace?run=r1" },
    ],
    ...over,
  };
}

describe("renderMorningDigestEmail", () => {
  it("renders the Yesterday section (pre-labeled lines) in html + text when provided", () => {
    const yesterdayLines = [
      "Your team ran 2 autonomous tasks yesterday: 1 finished, 1 failed (engineer). [observed]",
      'Goal "Hit 200 signups": signups unmeasured. [observed]',
    ];
    const r = renderMorningDigestEmail(richBrief(), { ...OPTS, yesterdayLines });
    expect(r.html).toContain("Yesterday");
    expect(r.html).not.toContain("[observed]");
    expect(r.html).toContain("signups unmeasured");
    expect(r.text).toContain("Yesterday:");
    expect(r.text).toContain(
      "  - Your team ran 2 autonomous tasks yesterday: 1 finished, 1 failed (engineer).",
    );
    expect(r.text).not.toContain("[observed]");
    const bare = renderMorningDigestEmail(richBrief(), OPTS);
    expect(bare.text).not.toContain("Yesterday:");
  });

  it("renders yesterday's activity + today's plan + goals in the HTML", () => {
    const r = renderMorningDigestEmail(richBrief(), OPTS);
    expect(r.html).toContain("What your AI team did");
    expect(r.html).toContain("2 builds started");
    expect(r.html).not.toContain("spent");
    expect(r.html).not.toContain("$4.20");
    expect(r.html).toContain("Build done: landing page");
    expect(r.html).toContain("Today's plan");
    expect(r.html).toContain("Goal progress");
    expect(r.html).toContain("Hit 200 signups");
  });

  it("subject keeps the count-phrase when there are approvals but no decision card (legacy fallback)", () => {
    const r = renderMorningDigestEmail(richBrief(), OPTS);
    expect(r.subject).toContain("4 things need your click");
    expect(r.html).toContain("A decision is waiting on you");
    expect(r.html).toContain("Review and approve");
    expect(r.html).toContain(OPTS.approvalsUrl);
    expect(r.text).toContain("Review and approve");
  });

  it("uses the singular 'thing needs' in the subject when exactly one approval is pending (no card)", () => {
    const r = renderMorningDigestEmail(
      richBrief({ today: { proposed_plans: 1, pending_suggestions: 2, pending_approvals: 1 } }),
      OPTS,
    );
    expect(r.subject).toContain("1 thing needs your click");
    expect(r.subject).not.toContain("things need");
  });

  it("A4 + slice 5: leads the subject + hero with the single decision when top_decisions is present", () => {
    const r = renderMorningDigestEmail(
      richBrief({
        top_decisions: [
          { id: "dec-1", title: "Shift $200/day to Search", recommendation: "Move from PMax", risk: "low" },
          { id: "dec-2", title: "Pause underperformer", risk: "low" },
        ],
        today: { proposed_plans: 1, pending_suggestions: 2, pending_approvals: 4 },
      }),
      OPTS,
    );
    expect(r.subject).toContain("Shift $200/day to Search");
    expect(r.subject).not.toContain("4 things");
    expect(r.html).toContain("Decisions waiting on you");
    expect(r.html).not.toContain("The one decision waiting on you");
    expect(r.html).toContain("Shift $200/day to Search");
    expect(r.html).toContain("tab=channels");
    expect(r.html).not.toContain("approve=dec-1");
    expect(r.html).toContain("Approve this decision");
    expect(r.html).toContain("queued");
    expect(r.text).toContain("Shift $200/day to Search");
    expect(r.text).toContain("tab=channels");
  });

  it("uses the singular 'The one decision waiting on you' only when exactly one is pending", () => {
    const r = renderMorningDigestEmail(
      richBrief({
        top_decisions: [{ id: "d1", title: "Approve the refund policy copy" }],
        today: { proposed_plans: 0, pending_suggestions: 0, pending_approvals: 1 },
      }),
      OPTS,
    );
    expect(r.html).toContain("The one decision waiting on you");
    expect(r.text).toContain("The one decision waiting on you:");
  });

  it("never emits the '+N mores' pluralization bug for the queued tail", () => {
    const r = renderMorningDigestEmail(
      richBrief({
        top_decisions: [{ id: "d1", title: "Lead decision" }],
        today: { proposed_plans: 0, pending_suggestions: 0, pending_approvals: 90 },
      }),
      OPTS,
    );
    expect(r.html).not.toContain("mores");
    expect(r.text).not.toContain("mores");
    expect(r.html).toContain("more queued");
  });

  it("Track 2: flags a critical decision card (Needs your attention + age) and counts criticals", () => {
    const r = renderMorningDigestEmail(
      richBrief({
        top_decisions: [
          { id: "c1", title: "Password reset token reuse", is_critical: true, age_days: 6 },
          { id: "n1", title: "Add a social proof bar", is_critical: false },
        ],
        today: {
          proposed_plans: 0,
          pending_suggestions: 0,
          pending_approvals: 12,
          critical_approvals: 1,
        },
      }),
      OPTS,
    );
    expect(r.html).toContain("Needs your attention");
    expect(r.html).toContain("open 6 days");
    expect(r.html).toContain("Password reset token reuse");
    expect(r.html).toContain("12 approvals waiting on you (1 need your attention)");
    expect(r.text).toContain("[Needs your attention · open 6d] Password reset token reuse");
  });

  it("Track 2: renders the funnel-health line when decisions expired unactioned recently", () => {
    const r = renderMorningDigestEmail(
      richBrief({
        today: {
          proposed_plans: 0,
          pending_suggestions: 0,
          pending_approvals: 3,
          expired_unread_recent: 9,
        },
      }),
      OPTS,
    );
    expect(r.html).toContain("9 decisions expired unactioned recently");
    expect(r.html).toContain("filling faster than it is being cleared");
    expect(r.text).toContain("9 decisions expired unactioned recently");
  });

  it("softens the CTA to 'Review in your workspace' with no false urgency when zero approvals", () => {
    const brief = richBrief({
      today: { proposed_plans: 1, pending_suggestions: 0, pending_approvals: 0 },
    });
    const r = renderMorningDigestEmail(brief, OPTS);
    expect(r.subject.toLowerCase()).not.toContain("needs your click");
    expect(r.html).not.toContain("1 thing needs your click");
    expect(r.html).toContain("Review in your workspace");
    expect(r.html).toContain("Nothing is blocked on you");
    expect(r.text).toContain("Review in your workspace");
  });

  it("includes the company name as a greeting", () => {
    const r = renderMorningDigestEmail(richBrief(), OPTS);
    expect(r.html).toContain("Acme Robotics");
    expect(r.text).toContain("Acme Robotics");
  });

  it("provides a non-empty plain-text fallback with the AI-team + today sections", () => {
    const r = renderMorningDigestEmail(richBrief(), OPTS);
    expect(r.text.length).toBeGreaterThan(0);
    expect(r.text).toContain("What your AI team did:");
    expect(r.text).toContain("Today's plan:");
    expect(r.text).toContain("Goal progress:");
  });

  it("is on-brand: product = Zavi, no em-dash in subject", () => {
    const r = renderMorningDigestEmail(richBrief(), OPTS);
    expect(r.subject).not.toContain("—");
    expect(r.text).toContain("Zavi");
  });

  it("falls back to a neutral greeting when displayName is absent", () => {
    const r = renderMorningDigestEmail(richBrief(), {
      workspaceUrl: OPTS.workspaceUrl,
      approvalsUrl: OPTS.approvalsUrl,
    });
    expect(r.subject.length).toBeGreaterThan(0);
    expect(r.html.length).toBeGreaterThan(0);
  });
});
