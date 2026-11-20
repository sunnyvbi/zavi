
import { describe, it, expect, vi } from "vitest";

type ChainResult = {
  data?: unknown;
  error?: { code?: string; message?: string } | null;
  count?: number | null;
};

function makeClient(tableResults: Record<string, ChainResult[]>) {
  function makeChain(table: string): Record<string, unknown> {
    const result = (tableResults[table] ?? []).shift() ?? { data: [], error: null };
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      in: () => chain,
      gte: () => chain,
      gt: () => chain,
      lt: () => chain,
      contains: () => chain,
      is: () => chain,
      not: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: () => Promise.resolve(result),
      then: (
        onFulfilled: (v: ChainResult) => unknown,
        onRejected?: (e: unknown) => unknown,
      ) => Promise.resolve(result).then(onFulfilled, onRejected),
    };
    return chain;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { from: (t: string) => makeChain(t) } as any;
}

import { assembleMorningBrief, buildDecisionCard } from "../morning-brief-assembler";

const NOW = new Date("2026-06-07T13:00:00.000Z");

describe("assembleMorningBrief — recent_activity dedupe (slice 3)", () => {
  it("collapses two identical proposed-plan rows to one activity item", async () => {
    const dupPlan = {
      id: "run-1",
      objective: "Launch the referral program",
      created_at: "2026-06-07T02:00:00.000Z",
    };
    const client = makeClient({
      conductor_runs: [
        { data: [], error: null },
        { data: [], error: null },
        { data: [], error: null },
        { data: [dupPlan, { ...dupPlan }], error: null },
      ],
      agent_runs: [{ data: [], error: null }],
      decisions: [
        { count: 0, data: null, error: null },
        { data: [], error: null },
        { count: 0, data: null, error: null },
      ],
      autopilot_goals: [{ data: [], error: null }],
      refine_suggestions: [{ count: 0, data: null, error: null }],
      autopilot_action_ledger: [{ data: [], error: null }],
    });

    const brief = await assembleMorningBrief(client, "tenant-1", NOW);

    const planItems = brief.recent_activity.filter((a) => a.kind === "plan_proposed");
    expect(planItems).toHaveLength(1);
    expect(planItems[0].label).toContain("Launch the referral program");
  });

  it("finding 1: surfaces audit-only _sanitize_violations when a goal had a banned string", async () => {
    const client = makeClient({
      conductor_runs: [
        { data: [], error: null },
        { data: [], error: null },
        { data: [], error: null },
        { data: [], error: null },
      ],
      agent_runs: [{ data: [], error: null }],
      decisions: [
        { count: 0, data: null, error: null },
        { data: [], error: null },
        { count: 0, data: null, error: null },
      ],
      autopilot_goals: [
        {
          data: [
            {
              objective: "QA test the launch",
              target_metric: "signups",
              current_value: null,
              target_value: 100,
              status: "active",
            },
          ],
          error: null,
        },
      ],
      refine_suggestions: [{ count: 0, data: null, error: null }],
      autopilot_action_ledger: [{ data: [], error: null }],
    });

    const brief = await assembleMorningBrief(client, "tenant-1", NOW);
    expect(brief._sanitize_violations).toContain("qa_test_string");
    expect(brief._sanitize_violations).toContain("lone_question_metric");
    expect(JSON.stringify(brief.goals)).not.toMatch(/qa\s*test/i);
  });
});

describe("assembleMorningBrief — growth 'do this first' (slice 4)", () => {
  const baseTables = () => ({
    conductor_runs: [
      { data: [], error: null },
      { data: [], error: null },
      { data: [], error: null },
      { data: [], error: null },
    ],
    agent_runs: [{ data: [], error: null }],
    decisions: [
      { count: 0, data: null, error: null },
      { data: [], error: null },
      { count: 0, data: null, error: null },
    ],
    autopilot_goals: [{ data: [], error: null }],
    refine_suggestions: [{ count: 0, data: null, error: null }],
    autopilot_action_ledger: [{ data: [], error: null }],
  });

  it("surfaces the plan note's now.action as growth_do_this_first", async () => {
    const client = makeClient({
      ...baseTables(),
      memory_note: [
        {
          data: [
            {
              metadata: {
                kind: "current_growth_plan",
                plan: {
                  stage: "leaky_loop",
                  now: { action: "Fix activation with a day-3 email", exec: "yes" },
                },
              },
            },
          ],
          error: null,
        },
      ],
    });
    const brief = await assembleMorningBrief(client, "tenant-1", NOW);
    expect(brief.growth_do_this_first).toBe("Fix activation with a day-3 email");
  });

  it("omits growth_do_this_first when no plan note exists", async () => {
    const client = makeClient(baseTables());
    const brief = await assembleMorningBrief(client, "tenant-1", NOW);
    expect(brief.growth_do_this_first == null).toBe(true);
  });

  it("scrubs an internal marker in the plan action before it ships", async () => {
    const client = makeClient({
      ...baseTables(),
      memory_note: [
        {
          data: [
            {
              metadata: {
                plan: {
                  stage: "pre_loop",
                  now: { action: "[proposed] Instrument the signup event", exec: "manual" },
                },
              },
            },
          ],
          error: null,
        },
      ],
    });
    const brief = await assembleMorningBrief(client, "tenant-1", NOW);
    expect(brief.growth_do_this_first).toBe("Instrument the signup event");
    expect(brief.growth_do_this_first).not.toContain("[proposed]");
    expect(brief._sanitize_violations).toContain("internal_marker");
  });
});

describe("buildDecisionCard (slice 5)", () => {
  it("titles a bulk email draft as not sent, never as a send", () => {
    const card = buildDecisionCard("d-bulk", "bulk_outbound.send", {
      selector: { segment: "lapsed_buyers" },
      template: { subject: "Come back", body_text: "We miss you" },
      est_recipient_count: 40,
    });
    expect(card?.title).toBe("Bulk email draft (not sent)");
    expect(card?.title).not.toMatch(/: send$/i);
  });

  it("extracts title/recommendation/impact/risk from a structured body", () => {
    const card = buildDecisionCard("d1", "growth-lead.reallocate-budget", {
      title: "Shift $200/day to Search",
      recommendation: "Move budget from PMax to Search",
      impact: "+12% ROAS",
      risk: "low",
    });
    expect(card).not.toBeNull();
    expect(card!.id).toBe("d1");
    expect(card!.title).toBe("Shift $200/day to Search");
    expect(card!.recommendation).toBe("Move budget from PMax to Search");
    expect(card!.impact).toBe("+12% ROAS");
    expect(card!.risk).toBe("low");
  });

  it("falls back to a humanized decision_class when the body has no title", () => {
    const card = buildDecisionCard("d2", "engineer.ship-pr", {});
    expect(card!.title).toBe("Engineer: ship pr");
  });

  it("uses decision_evidence.blast_radius as the risk fallback", () => {
    const card = buildDecisionCard("d3", "operator.dispatch", {
      summary: "Dispatch the engineer",
      decision_evidence: { blast_radius: "MEDIUM" },
    });
    expect(card!.title).toBe("Dispatch the engineer");
    expect(card!.risk).toBe("MEDIUM");
  });

  it("never throws on a malformed (non-object) body", () => {
    const card = buildDecisionCard("d4", "pm.plan", "not-an-object" as unknown);
    expect(card).not.toBeNull();
    expect(card!.title).toBe("Pm: plan");
  });

  it("extracts the title from body.theme (pm.needs_action), not the class fallback", () => {
    const card = buildDecisionCard("d5", "pm.needs_action", {
      theme: "Password reset token not invalidated after use, account takeover",
    });
    expect(card!.title).toContain("Password reset token");
    expect(card!.title).not.toBe("Pm: needs action");
  });

  it("extracts the title from body.intent (dispatch decisions), not the class fallback", () => {
    const card = buildDecisionCard("d6", "chief-of-staff.dispatch-specialist", {
      intent: "Instrument the signup event with activation tracking",
    });
    expect(card!.title).toContain("Instrument the signup event");
    expect(card!.title).not.toContain("dispatch specialist");
  });
});

describe("assembleMorningBrief — internal build provenance filter", () => {
  it("drops internal [refine]/smoke test builds from the count and activity", async () => {
    const yBuilds = [
      { id: "b1", objective: "Ship the pricing page", status: "done", kind: "build_app", created_at: "2026-06-06T05:00:00Z" },
      { id: "b2", objective: "[refine] tweak the footer year", status: "done", kind: "build_app", created_at: "2026-06-06T06:00:00Z" },
    ];
    const rBuilds = [
      { id: "b1", objective: "Ship the pricing page", status: "done", kind: "build_app", updated_at: "2026-06-06T05:00:00Z" },
      { id: "b2", objective: "[refine] tweak the footer year", status: "done", kind: "build_app", updated_at: "2026-06-06T06:00:00Z" },
    ];
    const client = makeClient({
      conductor_runs: [
        { data: yBuilds, error: null },
        { data: [], error: null },
        { data: rBuilds, error: null },
        { data: [], error: null },
      ],
      agent_runs: [{ data: [], error: null }],
      decisions: [
        { count: 0, data: null, error: null },
        { data: [], error: null },
        { count: 0, data: null, error: null },
      ],
      autopilot_goals: [{ data: [], error: null }],
      refine_suggestions: [{ count: 0, data: null, error: null }],
      autopilot_action_ledger: [{ data: [], error: null }],
    });

    const brief = await assembleMorningBrief(client, "tenant-1", NOW);
    expect(brief.yesterday.builds_started).toBe(1);
    const buildItems = brief.recent_activity.filter((a) => a.kind === "build_done");
    expect(buildItems).toHaveLength(1);
    expect(buildItems[0].label).toContain("Ship the pricing page");
    expect(JSON.stringify(brief.recent_activity)).not.toContain("refine");
  });
});

describe("assembleMorningBrief — Track 2 critical-first ranking + funnel health", () => {
  it("ranks a security-critical decision FIRST even when it is not the newest, tags age + counts", async () => {
    const decisionRows = [
      {
        id: "d-new",
        decision_class: "pm.needs_action",
        body: { theme: "Add a social proof bar to the landing page" },
        status: "proposed",
        emitted_at: "2026-06-07T09:00:00.000Z",
      },
      {
        id: "d-p0",
        decision_class: "pm.needs_action",
        body: { theme: "Password reset token not invalidated after use, account takeover" },
        status: "proposed",
        emitted_at: "2026-06-01T09:00:00.000Z",
      },
      {
        id: "d-old",
        decision_class: "growth-lead.lifecycle-draft",
        body: { theme: "Draft a re-engagement email" },
        status: "proposed",
        emitted_at: "2026-05-30T09:00:00.000Z",
      },
    ];
    const client = makeClient({
      conductor_runs: [
        { data: [], error: null },
        { data: [], error: null },
        { data: [], error: null },
        { data: [], error: null },
      ],
      agent_runs: [{ data: [], error: null }],
      decisions: [
        { count: 3, data: null, error: null },
        { data: decisionRows, error: null },
        { count: 4, data: null, error: null },
      ],
      autopilot_goals: [{ data: [], error: null }],
      refine_suggestions: [{ count: 0, data: null, error: null }],
      autopilot_action_ledger: [{ data: [], error: null }],
    });

    const brief = await assembleMorningBrief(client, "tenant-1", NOW);
    expect(brief.top_decisions?.[0].id).toBe("d-p0");
    expect(brief.top_decisions?.[0].is_critical).toBe(true);
    expect(brief.top_decisions?.[0].title).toContain("Password reset token");
    expect(brief.top_decisions?.[0].age_days).toBeGreaterThanOrEqual(5);
    expect(brief.top_decisions?.find((d) => d.id === "d-new")?.is_critical).toBe(false);
    expect(brief.today.critical_approvals).toBe(1);
    expect(brief.today.expired_unread_recent).toBe(4);
  });

  it("EVICTION: with more criticals than slots, the OLDEST criticals render (2026-07-18)", async () => {
    const mk = (id: string, theme: string, emitted_at: string) => ({
      id,
      decision_class: "pm.needs_action",
      body: { theme },
      status: "proposed",
      emitted_at,
    });
    const decisionRows = [
      mk("c-newest", "IDOR exposes other users' records", "2026-06-06T09:00:00.000Z"),
      mk("c-newer", "Exposed secret token in the repo", "2026-06-05T09:00:00.000Z"),
      mk("benign", "Add a social proof bar to the landing page", "2026-06-04T09:00:00.000Z"),
      mk("c-mid", "Password hash leaking in queries", "2026-06-03T09:00:00.000Z"),
      mk("c-old", "Unauthorized payout on pay-later bookings", "2026-06-02T09:00:00.000Z"),
      mk("c-older", "Account takeover via profile change", "2026-06-01T09:00:00.000Z"),
      mk("c-oldest", "Rotate the exposed PEM private deploy key", "2026-05-28T09:00:00.000Z"),
    ];
    const client = makeClient({
      conductor_runs: [
        { data: [], error: null },
        { data: [], error: null },
        { data: [], error: null },
        { data: [], error: null },
      ],
      agent_runs: [{ data: [], error: null }],
      decisions: [
        { count: 7, data: null, error: null },
        { data: decisionRows, error: null },
        { count: 0, data: null, error: null },
      ],
      autopilot_goals: [{ data: [], error: null }],
      refine_suggestions: [{ count: 0, data: null, error: null }],
      autopilot_action_ledger: [{ data: [], error: null }],
    });

    const brief = await assembleMorningBrief(client, "tenant-1", NOW);
    const ids = (brief.top_decisions ?? []).map((d) => d.id);
    expect(ids).toEqual(["c-oldest", "c-older", "c-old", "c-mid", "c-newer"]);
    expect(ids).not.toContain("c-newest");
    expect(ids).not.toContain("benign");
    expect(brief.today.critical_approvals).toBe(6);
  });
});
