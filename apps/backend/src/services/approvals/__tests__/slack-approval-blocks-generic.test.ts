import { describe, it, expect } from "vitest";
import { buildApprovalBlocks } from "../slack-approval-blocks";

function flatText(blocks: unknown[]): string {
  return JSON.stringify(blocks);
}

describe("buildApprovalBlocks — generic body summarizer (no decision_evidence, non-meta_ads)", () => {
  it("growth-lead.reallocate-budget: renders bet, from→to, amount, confidence, rationale — NOT 'No structured evidence'", () => {
    const blocks = buildApprovalBlocks({
      id: "g1",
      decision_class: "growth-lead.reallocate-budget",
      body: {
        bet_claim: "Shift spend from paid search to founder-led LinkedIn",
        from_channel: "google-search",
        to_channel: "linkedin-organic",
        amount_usd: 50,
        amount_qualitative: false,
        confidence: "high",
        rationale:
          "Paid search CAC has climbed 40% over 3 weeks while LinkedIn organic is driving the highest-intent demo requests.",
        source_run_id: "run_abc",
        source_signals: [{ tool: "growth__diagnose_funnel", signal: "x" }],
      },
    });
    const s = flatText(blocks);
    expect(s).not.toContain("No structured evidence");
    expect(s).toContain("Shift spend from paid search");
    expect(s).toContain("$50/wk");
    expect(s).toContain("google-search");
    expect(s).toContain("linkedin-organic");
    expect(s).toContain("high");
    expect(s).toContain("CAC has climbed 40%");
    expect(s).not.toContain("run_abc");
    expect(s).not.toContain("growth__diagnose_funnel");
    expect(s).toContain("praxis_approve");
    expect(s).toContain("praxis_reject");
  });

  it("qualitative amount renders NO Amount row (was placeholder noise 'Amount: qualitative')", () => {
    const blocks = buildApprovalBlocks({
      id: "g2",
      decision_class: "growth-lead.reallocate-budget",
      body: {
        bet_claim: "Test a referral loop",
        to_channel: "referral",
        amount_usd: null,
        amount_qualitative: true,
        confidence: "medium",
        rationale: "Cheap to try.",
      },
    });
    const s = flatText(blocks);
    expect(s).not.toContain("No structured evidence");
    expect(s).toContain("Test a referral loop");
    expect(s).toContain("Cheap to try");
    expect(s).toContain("referral");
    expect(s).not.toContain("qualitative");
    expect(s).not.toContain('"*Amount*');
  });

  it("lifecycle-draft with from_channel 'n/a' suppresses the placeholder From row", () => {
    const blocks = buildApprovalBlocks({
      id: "lc1",
      decision_class: "growth-lead.lifecycle-draft",
      body: {
        bet_claim: "Force cancel-reason capture to 100% on every cancellation",
        from_channel: "n/a",
        to_channel: "cancel-reason UX",
        amount_usd: null,
        amount_qualitative: true,
        confidence: "high",
        rationale: "Surfaces the first rankable constraint within 2-3 weeks.",
        draft: "Add a required 'reason for cancellation' field to both cancel flows.",
      },
    });
    const s = flatText(blocks);
    expect(s).not.toContain("No structured evidence");
    expect(s).toContain("Force cancel-reason capture");
    expect(s).toContain("cancel-reason UX");
    expect(s).toContain("Add a required");
    expect(s).not.toContain("n/a");
    expect(s).not.toContain("qualitative");
  });

  it("advisor send_email renders the subject + FULL body_text (was dropped by the ≤120-char scalar cap)", () => {
    const longBody =
      "Hi team,\n\n" + "This is the full body of the advisor email. ".repeat(20) + "\n\nBest,\nZavi";
    const blocks = buildApprovalBlocks({
      id: "se1",
      decision_class: "send_email",
      body: {
        to: "founder@acme.com",
        subject: "Zavi Advisor — 2026-07-05",
        body_text: longBody,
        artifact_id: "11111111-2222-3333-4444-555555555555",
      },
    });
    const s = flatText(blocks);
    expect(s).not.toContain("No structured evidence");
    expect(s).toContain("Zavi Advisor — 2026-07-05");
    expect(s).toContain("founder@acme.com");
    expect(s).toContain("full body of the advisor email");
    expect(s).not.toContain("Artifact Id");
  });

  it("growth-lead.dispatch-specialist carries the Draft — not a bare routing stub", () => {
    const blocks = buildApprovalBlocks({
      id: "ds1",
      decision_class: "growth-lead.dispatch-specialist",
      body: {
        target_agent_slug: "engineer",
        intent:
          "Growth bet: Force cancel-reason capture\nSpec / draft to ship:\nAdd a required reason field to both cancel flows.",
        draft: "Add a required reason field to both cancel flows; disable Confirm-Cancel until selected.",
        origin_decision_id: "dec_abc",
        dispatched_by: "growth-lead",
      },
    });
    const s = flatText(blocks);
    expect(s).not.toContain("No structured evidence");
    expect(s).toContain("engineer");
    expect(s).toContain("Add a required reason field");
    expect(s).not.toContain("dec_abc");
  });

  it("heartbeat.automation-proposal: renders objective/cadence/target detail — NOT 'No structured evidence'", () => {
    const blocks = buildApprovalBlocks({
      id: "h1",
      decision_class: "heartbeat.automation-proposal",
      body: {
        objective: "Automate the weekly performance-marketing budget review",
        cadence: "weekly",
        target_agent_slug: "performance-marketer",
        rationale:
          "You've manually triggered the perf review every Monday for the last 4 weeks — propose scheduling it.",
      },
    });
    const s = flatText(blocks);
    expect(s).not.toContain("No structured evidence");
    expect(s).toContain("Automate the weekly performance-marketing budget review");
    expect(s).toContain("weekly");
    expect(s).toContain("performance-marketer");
    expect(s).toContain("manually triggered the perf review");
    expect(s).toContain("praxis_approve");
  });

  it("empty body still shows the contentless fallback (unchanged)", () => {
    const blocks = buildApprovalBlocks({ id: "e1", decision_class: "growth-lead.lifecycle-draft", body: {} });
    expect(flatText(blocks)).toContain("No structured evidence");
  });

  it("null body still shows the contentless fallback (unchanged)", () => {
    const blocks = buildApprovalBlocks({ id: "e2", decision_class: "some.class", body: null });
    expect(flatText(blocks)).toContain("No structured evidence");
  });

  it("a body with ONLY internal/noise keys shows the contentless fallback (nothing meaningful to render)", () => {
    const blocks = buildApprovalBlocks({
      id: "e3",
      decision_class: "some.class",
      body: { source_run_id: "run_x", source_signals: [{ tool: "t", signal: "s" }] },
    });
    expect(flatText(blocks)).toContain("No structured evidence");
  });

  it("decision_evidence envelope still wins over the generic summarizer (unchanged)", () => {
    const blocks = buildApprovalBlocks({
      id: "g3",
      decision_class: "growth-lead.reallocate-budget",
      body: {
        bet_claim: "should-not-be-the-lead",
        decision_evidence: {
          reason_text: "Envelope reason wins",
          evidence: ["e"],
          alternatives_considered: [],
          reversibility: "reversible",
          blast_radius: "GREEN",
          confidence: 0.9,
        },
      },
    });
    const s = flatText(blocks);
    expect(s).toContain("Envelope reason wins");
    expect(s).not.toContain("should-not-be-the-lead");
  });

  it("skips internal/opaque-id scalar keys (e.g. send_email's artifact_id) generically", () => {
    const blocks = buildApprovalBlocks({
      id: "i1",
      decision_class: "advisor.send_email",
      body: {
        objective: "Email the investor update",
        artifact_id: "11111111-2222-3333-4444-555555555555",
        scheduled_at: "2026-06-30T09:00:00Z",
        thread_id: "abc",
        channel: "email",
      },
    });
    const s = flatText(blocks);
    expect(s).not.toContain("No structured evidence");
    expect(s).toContain("Email the investor update");
    expect(s).toContain("email");
    expect(s).not.toContain("Artifact Id");
    expect(s).not.toContain("Scheduled At");
    expect(s).not.toContain("Thread Id");
  });

  it("caps a pathologically long field label so it can't blow Slack's field limit", () => {
    const longKey = "x".repeat(2500);
    const blocks = buildApprovalBlocks({
      id: "l1",
      decision_class: "some.class",
      body: { [longKey]: "v" },
    });
    const fieldSection = (blocks as Array<{ type: string; fields?: Array<{ text: string }> }>).find(
      (b) => b.type === "section" && Array.isArray(b.fields),
    );
    expect(fieldSection).toBeTruthy();
    for (const f of fieldSection!.fields as Array<{ text: string }>) {
      expect(f.text.length).toBeLessThan(200);
    }
  });

  it("caps generic fields at 8 to avoid an unbounded Slack section", () => {
    const body: Record<string, unknown> = {};
    for (let i = 0; i < 20; i++) body[`field_${i}`] = `val${i}`;
    const blocks = buildApprovalBlocks({ id: "c1", decision_class: "some.class", body });
    const fieldSection = (blocks as Array<{ type: string; fields?: unknown[] }>).find(
      (b) => b.type === "section" && Array.isArray(b.fields),
    );
    expect(fieldSection).toBeTruthy();
    expect((fieldSection!.fields as unknown[]).length).toBeLessThanOrEqual(8);
  });
});

const CANONICAL_CARD_FIXTURES: Array<{
  name: string;
  decision_class: string;
  body: Record<string, unknown>;
  mustContain: string[];
}> = [
  {
    name: "growth-lead.reallocate-budget (real $ amount)",
    decision_class: "growth-lead.reallocate-budget",
    body: {
      bet_claim: "Shift spend to LinkedIn",
      from_channel: "google-search",
      to_channel: "linkedin-organic",
      amount_usd: 50,
      amount_qualitative: false,
      confidence: "high",
      rationale: "Paid CAC up 40%.",
    },
    mustContain: ["Shift spend to LinkedIn", "$50/wk"],
  },
  {
    name: "growth-lead.lifecycle-draft (qualitative, n/a from)",
    decision_class: "growth-lead.lifecycle-draft",
    body: {
      bet_claim: "Force cancel-reason capture",
      from_channel: "n/a",
      to_channel: "cancel-reason UX",
      amount_qualitative: true,
      confidence: "high",
      rationale: "Surfaces the first constraint.",
      draft: "Add a required reason field to both cancel flows.",
    },
    mustContain: ["Force cancel-reason capture", "Add a required reason field"],
  },
  {
    name: "growth-lead.dispatch-specialist (carries draft)",
    decision_class: "growth-lead.dispatch-specialist",
    body: {
      target_agent_slug: "engineer",
      intent: "Growth bet: X\nSpec / draft to ship:\nBuild the field.",
      draft: "Build the required cancel-reason field.",
      origin_decision_id: "dec_1",
      dispatched_by: "growth-lead",
    },
    mustContain: ["engineer", "Build the required cancel-reason field"],
  },
  {
    name: "advisor send_email",
    decision_class: "send_email",
    body: {
      to: "founder@acme.com",
      subject: "Zavi Advisor — daily",
      body_text: "The full email body the founder must see before approving.",
      artifact_id: "11111111-2222-3333-4444-555555555555",
    },
    mustContain: ["Zavi Advisor — daily", "full email body"],
  },
  {
    name: "chief-of-staff.dispatch-specialist",
    decision_class: "chief-of-staff.dispatch-specialist",
    body: {
      target_agent_slug: "performance-marketer",
      intent: "Review last week's ad spend and flag overspend.",
    },
    mustContain: ["performance-marketer", "Review last week"],
  },
  {
    name: "chief-of-staff.daily-digest (rendered_markdown)",
    decision_class: "chief-of-staff.daily-digest",
    body: {
      rendered_markdown: "## Today\n- Ship the render fix\n- Review 2 PRs",
      tier1: [{ title: "Ship the render fix" }],
      tier2: [],
    },
    mustContain: ["Today", "Ship the render fix"],
  },
  {
    name: "content-design.propose-change (rendered_markdown)",
    decision_class: "content-design.propose-change",
    body: {
      title: "Rewrite the pricing page hero",
      rendered_markdown: "## Proposed change\nTighten the hero headline.",
      change_type: "copy",
      files: ["apps/web/app/pricing/page.tsx"],
    },
    mustContain: ["Proposed change", "Tighten the hero headline"],
  },
];

describe("buildApprovalBlocks — fleet coverage guard (every emitted class renders a fit card)", () => {
  CANONICAL_CARD_FIXTURES.forEach((fx, i) => {
    it(`${fx.name}: fit card, no contentless / no placeholder noise`, () => {
      const blocks = buildApprovalBlocks({ id: `cov-${i}`, decision_class: fx.decision_class, body: fx.body });
      const s = flatText(blocks);
      expect(s).not.toContain("No structured evidence");
      expect(s).not.toContain("qualitative");
      expect(s).not.toMatch(/\*(From|To)\*\\n(n\/a|none|unknown|tbd)/i);
      for (const needle of fx.mustContain) expect(s).toContain(needle);
      expect(s).toContain("praxis_approve");
      expect(s).toContain("praxis_reject");
    });
  });
});
