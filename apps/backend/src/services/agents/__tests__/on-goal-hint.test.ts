import { describe, it, expect } from "vitest";
import {
  computeOnGoalHint,
  isSelfInitiatedTrigger,
  maybeAttachOnGoalHint,
  type ActiveGoal,
} from "../on-goal-hint";

const goals = (...objs: string[]): ActiveGoal[] =>
  objs.map((objective) => ({ objective, target_metric: null }));

describe("isSelfInitiatedTrigger", () => {
  it("treats cron/scheduled/playbook as self-initiated", () => {
    expect(isSelfInitiatedTrigger("cron")).toBe(true);
    expect(isSelfInitiatedTrigger("scheduled")).toBe(true);
    expect(isSelfInitiatedTrigger("playbook")).toBe(true);
  });
  it("treats human/unknown triggers as NOT self-initiated", () => {
    for (const t of ["chat", "slack", "email", "manual", "a2a", "handoff", "mcp", "webhook", "weird"]) {
      expect(isSelfInitiatedTrigger(t)).toBe(false);
    }
  });
});

describe("computeOnGoalHint (pure heuristic)", () => {
  it("self-initiated + matching goal → relevant:true hint referencing the goal", () => {
    const hint = computeOnGoalHint({
      trigger: "cron",
      decisionClass: "growth.propose_campaign",
      body: { title: "Boost host supply in Texas", summary: "Recruit more hosts" },
      activeGoals: goals("Grow host supply to 800 hosts"),
    });
    expect(hint).not.toBeNull();
    expect(hint!.relevant).toBe(true);
    expect(hint!.note).toContain("host supply");
  });

  it("self-initiated + NO goal on file → honest relevant:'unknown' (never fabricated)", () => {
    const hint = computeOnGoalHint({
      trigger: "scheduled",
      decisionClass: "growth.propose_campaign",
      body: { title: "Boost host supply" },
      activeGoals: [],
    });
    expect(hint).not.toBeNull();
    expect(hint!.relevant).toBe("unknown");
    expect(hint!.note.toLowerCase()).toContain("no active goal");
  });

  it("self-initiated + goals exist but NO overlap → relevant:false, names the goals", () => {
    const hint = computeOnGoalHint({
      trigger: "cron",
      decisionClass: "support.escalate_ticket",
      body: { title: "Escalate refund dispute", summary: "chargeback handling" },
      activeGoals: goals("Grow host supply to 800 hosts", "Reach $200k monthly GMV"),
    });
    expect(hint).not.toBeNull();
    expect(hint!.relevant).toBe(false);
    expect(hint!.note).toContain("host supply");
  });

  it("human-requested trigger → NO hint (null)", () => {
    const hint = computeOnGoalHint({
      trigger: "chat",
      decisionClass: "growth.propose_campaign",
      body: { title: "Grow host supply" },
      activeGoals: goals("Grow host supply to 800 hosts"),
    });
    expect(hint).toBeNull();
  });
});

describe("computeOnGoalHint — dispatch bodies score their `intent`", () => {
  it("matches a goal named only in the intent text", () => {
    const hint = computeOnGoalHint({
      trigger: "cron",
      decisionClass: "chief-of-staff.dispatch-specialist",
      body: {
        target_agent_slug: "growth-lead",
        intent: "Run a weekly plan to lift guest signups toward the 500 target.",
      },
      activeGoals: goals("Grow Upcar weekly guest signups to 500"),
    });
    expect(hint!.relevant).toBe(true);
    expect(hint!.note).toContain("signups");
  });

  it("still reports an HONEST miss when the intent genuinely does not map", () => {
    const hint = computeOnGoalHint({
      trigger: "cron",
      decisionClass: "chief-of-staff.dispatch-specialist",
      body: {
        target_agent_slug: "support-lead",
        intent: "Card-testing attack on cus_X: 8 failed charges in ~90 min today.",
      },
      activeGoals: goals("Grow Upcar weekly guest signups to 500"),
    });
    expect(hint!.relevant).toBe(false);
  });

  it("a body with no intent behaves exactly as before (no throw, class-slug only)", () => {
    const hint = computeOnGoalHint({
      trigger: "cron",
      decisionClass: "chief-of-staff.dispatch-specialist",
      body: { target_agent_slug: "engineer", intent: 42 },
      activeGoals: goals("Grow Upcar weekly guest signups to 500"),
    });
    expect(hint!.relevant).toBe(false);
  });
});

describe("maybeAttachOnGoalHint (fail-open orchestration)", () => {
  it("attaches on_goal_hint for a self-initiated action with a matching goal", async () => {
    const out = (await maybeAttachOnGoalHint(
      {
        tenant_id: "t1",
        trigger: "cron",
        decisionClass: "growth.propose_campaign",
        body: { title: "Boost host supply", summary: "recruit hosts" },
      },
      { fetchActiveGoals: async () => goals("Grow host supply to 800 hosts") },
    )) as Record<string, unknown>;
    expect(out.title).toBe("Boost host supply");
    expect(out.on_goal_hint).toEqual({
      relevant: true,
      note: expect.stringContaining("host supply"),
    });
  });

  it("attaches an honest 'unknown' hint when no goal is on file", async () => {
    const out = (await maybeAttachOnGoalHint(
      {
        tenant_id: "t1",
        trigger: "playbook",
        decisionClass: "growth.propose_campaign",
        body: { title: "Boost host supply" },
      },
      { fetchActiveGoals: async () => [] },
    )) as Record<string, unknown>;
    const hint = out.on_goal_hint as { relevant: unknown; note: string };
    expect(hint.relevant).toBe("unknown");
    expect(hint.note.toLowerCase()).toContain("no active goal");
  });

  it("human-requested action → body returned UNCHANGED (no hint field)", async () => {
    const body = { title: "Grow host supply" };
    const out = await maybeAttachOnGoalHint(
      {
        tenant_id: "t1",
        trigger: "chat",
        decisionClass: "growth.propose_campaign",
        body,
      },
      {
        fetchActiveGoals: async () => {
          throw new Error("must not be called on the human path");
        },
      },
    );
    expect(out).toBe(body);
    expect((out as Record<string, unknown>).on_goal_hint).toBeUndefined();
  });

  it("fetch error → card UNCHANGED (fail-open, never throws)", async () => {
    const body = { title: "Boost host supply" };
    const out = await maybeAttachOnGoalHint(
      {
        tenant_id: "t1",
        trigger: "cron",
        decisionClass: "growth.propose_campaign",
        body,
      },
      {
        fetchActiveGoals: async () => {
          throw new Error("db blew up");
        },
      },
    );
    expect(out).toBe(body);
    expect((out as Record<string, unknown>).on_goal_hint).toBeUndefined();
  });

  it("does not mutate the input body (returns a copy)", async () => {
    const body = { title: "Boost host supply" };
    const out = await maybeAttachOnGoalHint(
      {
        tenant_id: "t1",
        trigger: "cron",
        decisionClass: "growth.propose_campaign",
        body,
      },
      { fetchActiveGoals: async () => goals("Grow host supply") },
    );
    expect(out).not.toBe(body);
    expect((body as Record<string, unknown>).on_goal_hint).toBeUndefined();
  });
});
