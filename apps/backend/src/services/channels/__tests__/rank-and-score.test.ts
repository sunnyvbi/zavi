import { describe, expect, it } from "vitest";
import { rankActions, isOpenAction, type RankableAction } from "../rank-actions";
import { SCORE_VERSION, SCORE_WEIGHTS, scoreAction, titleKey } from "../score-action";

const NOW = Date.parse("2026-09-18T12:00:00Z");

function card(over: Partial<RankableAction> & { id: string }): RankableAction {
  return {
    blocking: false,
    position: 2,
    score: 50,
    proposed_at: "2026-09-18T10:00:00Z",
    status: "pending",
    snoozed_until: null,
    ...over,
  };
}

const base = {
  impact: null,
  position: 1,
  run_of: 5,
  channel_in_plan: false,
  metric_matches_goal: false,
  previously_rejected: false,
};

describe("scoreAction", () => {
  it("impact null scores exactly like impact 3", () => {
    expect(scoreAction({ ...base, impact: null }).score).toBe(scoreAction({ ...base, impact: 3 }).score);
    expect(scoreAction({ ...base, impact: null }).score_inputs.impact_n).toBe(0.5);
  });

  it("follows the formula and records every input", () => {
    const s = scoreAction({ ...base, impact: 5, position: 2, run_of: 5, channel_in_plan: true, metric_matches_goal: true });
    expect(s.score).toBe(96.25);
    expect(s.score_inputs).toMatchObject({
      impact: 5,
      impact_n: 1,
      goal_fit: 1,
      rank_n: 0.75,
      position: 2,
      run_of: 5,
      channel_in_plan: true,
      metric_matches_goal: true,
      previously_rejected: false,
      weights: SCORE_WEIGHTS,
      version: SCORE_VERSION,
    });
  });

  it("goal_fit is 0.5 when only one of plan / goal holds", () => {
    expect(scoreAction({ ...base, channel_in_plan: true }).score_inputs.goal_fit).toBe(0.5);
    expect(scoreAction({ ...base, metric_matches_goal: true }).score_inputs.goal_fit).toBe(0.5);
  });

  it("a rejected re-proposal drops by the penalty, floored at 0", () => {
    const fresh = scoreAction({ ...base, impact: 4 }).score;
    const rejected = scoreAction({ ...base, impact: 4, previously_rejected: true }).score;
    expect(fresh - rejected).toBe(SCORE_WEIGHTS.previously_rejected);
    expect(scoreAction({ ...base, impact: 1, position: 5, previously_rejected: true }).score).toBe(0);
  });

  it("an out-of-range impact is treated as none, never trusted", () => {
    expect(scoreAction({ ...base, impact: 9 }).score_inputs.impact).toBeNull();
    expect(scoreAction({ ...base, impact: 2.5 }).score_inputs.impact).toBeNull();
  });

  it("a one-action run gets full rank credit", () => {
    expect(scoreAction({ ...base, position: 1, run_of: 1 }).score_inputs.rank_n).toBe(1);
  });

  it("titleKey collapses case, punctuation and whitespace", () => {
    expect(titleKey("  Pause the $592 zero-conversion  IG campaign! ")).toBe("pause the 592 zero conversion ig campaign");
  });
});

describe("rankActions", () => {
  it("a blocker outranks every non-blocker at any score", () => {
    const ranked = rankActions(
      [card({ id: "hi", score: 100 }), card({ id: "blk", blocking: true, score: 0 })],
      { nowMs: NOW },
    );
    expect(ranked.actions.map((a) => a.id)).toEqual(["blk", "hi"]);
  });

  it("orders by score, then older first, then id", () => {
    const ranked = rankActions(
      [
        card({ id: "b", score: 40, proposed_at: "2026-09-15T00:00:00Z" }),
        card({ id: "a", score: 40, proposed_at: "2026-09-15T00:00:00Z" }),
        card({ id: "old", score: 40, proposed_at: "2026-09-10T00:00:00Z" }),
        card({ id: "top", score: 90 }),
      ],
      { nowMs: NOW },
    );
    expect(ranked.actions.map((a) => a.id)).toEqual(["top", "old", "a", "b"]);
  });

  it("top 5 plus a `more` count; all=1 returns everything open", () => {
    const many = Array.from({ length: 8 }, (_, i) => card({ id: `c${i}`, score: i }));
    const top = rankActions(many, { nowMs: NOW });
    expect(top.actions).toHaveLength(5);
    expect(top.more).toBe(3);
    expect(rankActions(many, { nowMs: NOW, all: true }).actions).toHaveLength(8);
  });

  it("a 3-day-old open action still shows when it outranks today's", () => {
    const ranked = rankActions(
      [
        card({ id: "old", score: 80, proposed_at: "2026-09-15T00:00:00Z" }),
        ...Array.from({ length: 5 }, (_, i) => card({ id: `new${i}`, score: 50 })),
      ],
      { nowMs: NOW },
    );
    expect(ranked.actions[0].id).toBe("old");
  });

  it("a rejected repeat ranks lower but is never hidden", () => {
    const fresh = scoreAction({ ...base, impact: 3, position: 2 });
    const repeat = scoreAction({ ...base, impact: 3, position: 2, previously_rejected: true });
    const ranked = rankActions(
      [card({ id: "repeat", score: repeat.score }), card({ id: "fresh", score: fresh.score })],
      { nowMs: NOW, all: true },
    );
    expect(ranked.actions.map((a) => a.id)).toEqual(["fresh", "repeat"]);
  });

  it("history never ranks; an expired snooze reads as open", () => {
    const rows = [
      card({ id: "acted", status: "acted" }),
      card({ id: "rejected", status: "rejected" }),
      card({ id: "redone", status: "redone" }),
      card({ id: "stale", status: "stale" }),
      card({ id: "snoozed", status: "snoozed", snoozed_until: "2026-09-20T00:00:00Z" }),
      card({ id: "due", status: "snoozed", snoozed_until: "2026-09-17T00:00:00Z" }),
    ];
    expect(rankActions(rows, { nowMs: NOW, all: true }).actions.map((a) => a.id)).toEqual(["due"]);
    expect(isOpenAction({ status: "snoozed", snoozed_until: null }, NOW)).toBe(true);
  });

  it("falsifier: each run's own #1 lands in the top 5 when impacts are comparable", () => {
    const impacts = [3, 4, 2, 3, 1];
    const run = (prefix: string, at: string) =>
      impacts.map((imp, i) =>
        card({
          id: `${prefix}${i + 1}`,
          proposed_at: at,
          score: scoreAction({ ...base, impact: imp, position: i + 1, run_of: 5 }).score,
        }),
      );
    const top = rankActions([...run("o", "2026-09-12T00:00:00Z"), ...run("n", "2026-09-18T00:00:00Z")], {
      nowMs: NOW,
    }).actions.map((a) => a.id);
    expect(top).toContain("n1");
    expect(top).toContain("o1");
  });

  it("the newest run's UNRATED #1 is in the top 5 even when an older run rated everything 4", () => {
    expect(scoreAction({ ...base, impact: null, position: 1, run_of: 5 }).score).toBe(
      scoreAction({ ...base, impact: 4, position: 5, run_of: 5 }).score,
    );
    const older = Array.from({ length: 5 }, (_, i) =>
      card({
        id: `o${i + 1}`,
        position: i + 1,
        proposed_at: "2026-09-12T00:00:00Z",
        score: scoreAction({ ...base, impact: 4, position: i + 1, run_of: 5 }).score,
      }),
    );
    const newer = Array.from({ length: 5 }, (_, i) =>
      card({
        id: `n${i + 1}`,
        position: i + 1,
        score: scoreAction({ ...base, impact: i === 0 ? null : 2, position: i + 1, run_of: 5 }).score,
      }),
    );
    const top = rankActions([...older, ...newer], { nowMs: NOW }).actions.map((a) => a.id);
    expect(top).toHaveLength(5);
    expect(top).toContain("n1");
    expect(top).toContain("o1");
  });

  it("a run's #1 ranks after blockers and ahead of any higher-scored non-#1", () => {
    const ranked = rankActions(
      [
        card({ id: "hi", position: 2, score: 99 }),
        card({ id: "first", position: 1, score: 1 }),
        card({ id: "blk", position: 3, blocking: true, score: 0 }),
      ],
      { nowMs: NOW },
    );
    expect(ranked.actions.map((a) => a.id)).toEqual(["blk", "first", "hi"]);
  });

  it("more than 5 guaranteed rows: ordered by the same tail, 5 taken, rest counted", () => {
    const rows = [
      card({ id: "b1", position: 2, blocking: true, score: 10 }),
      card({ id: "b2", position: 1, blocking: true, score: 80 }),
      card({ id: "f1", position: 1, score: 70, proposed_at: "2026-09-10T00:00:00Z" }),
      card({ id: "f2", position: 1, score: 70, proposed_at: "2026-09-11T00:00:00Z" }),
      card({ id: "f3", position: 1, score: 90 }),
      card({ id: "f4", position: 1, score: 20 }),
      card({ id: "f5", position: 1, score: 5 }),
      card({ id: "x", position: 2, score: 100 }),
    ];
    const ranked = rankActions(rows, { nowMs: NOW });
    expect(ranked.actions.map((a) => a.id)).toEqual(["b2", "b1", "f3", "f1", "f2"]);
    expect(ranked.more).toBe(3);
    expect(rankActions(rows, { nowMs: NOW, all: true }).actions.map((a) => a.id)).toEqual([
      "b2", "b1", "f3", "f1", "f2", "f4", "f5", "x",
    ]);
  });

  it("a run's #1 that is snoozed-not-due or closed gets no guarantee", () => {
    const rows = [
      card({ id: "snz", position: 1, status: "snoozed", snoozed_until: "2026-09-25T00:00:00Z" }),
      card({ id: "rej", position: 1, status: "rejected" }),
      card({ id: "open", position: 3 }),
    ];
    expect(rankActions(rows, { nowMs: NOW, all: true }).actions.map((a) => a.id)).toEqual(["open"]);
  });
});

describe("drafts are capped against drafts, not against chores", () => {
  const chore = (id: string, score: number) => card({ id, score, action_type: "check", position: 2 });
  const post = (id: string, score: number) => card({ id, score, action_type: "text_post", position: 2 });

  it("keeps every post the run wrote even when five chores outscore them", () => {
    const rows = [
      chore("c1", 45), chore("c2", 43), chore("c3", 41), chore("c4", 40), chore("c5", 39),
      post("p1", 37), post("p2", 35), post("p3", 33),
    ];
    const { actions, more } = rankActions(rows, { nowMs: NOW });
    expect(actions.map((a) => a.id)).toEqual(["c1", "c2", "c3", "c4", "c5", "p1", "p2", "p3"]);
    expect(more).toBe(0);
  });

  it("caps the drafts too: a sixth post is over, and it is the worst one", () => {
    const rows = [post("p1", 37), post("p2", 36), post("p3", 35), post("p4", 34), post("p5", 33), post("p6", 32)];
    expect(rankActions(rows, { nowMs: NOW }).actions.map((a) => a.id)).toEqual(["p1", "p2", "p3", "p4", "p5"]);
    expect(rankActions(rows, { nowMs: NOW }).more).toBe(1);
  });

  it("a channel whose rows name no type still gets one top five", () => {
    const rows = ["a", "b", "c", "d", "e", "f"].map((id, i) => card({ id, score: 50 - i }));
    const { actions, more } = rankActions(rows, { nowMs: NOW });
    expect(actions.map((a) => a.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(more).toBe(1);
  });
});
