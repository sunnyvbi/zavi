import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/supabase", () => ({ serviceClient: () => ({}) }));

import { buildReview, replayApply } from "../decision-replay";
import { LIVE_DEFAULT_CASES, REPLAY_CASES, type ReplayCase } from "../replay-cases";

function run(c: ReplayCase, text: string) {
  const { payload } = buildReview(c.world);
  return replayApply(c.world, payload, text);
}

describe("decision replay: the cases", () => {
  it("has ~20 cases, unique ids, both kinds, and the live defaults exist", () => {
    expect(REPLAY_CASES.length).toBeGreaterThanOrEqual(20);
    expect(new Set(REPLAY_CASES.map((c) => c.id)).size).toBe(REPLAY_CASES.length);
    expect(REPLAY_CASES.some((c) => c.kind === "positive")).toBe(true);
    for (const id of LIVE_DEFAULT_CASES) expect(REPLAY_CASES.some((c) => c.id === id)).toBe(true);
    expect(LIVE_DEFAULT_CASES.length).toBeLessThanOrEqual(5);
  });
});

describe.each(REPLAY_CASES.map((c) => [c.id, c] as const))("%s", (_id, c) => {
  it("the review cgo reads carries the incident's facts (built through the live shapes)", () => {
    const { payload, userPrompt } = buildReview(c.world);
    expect(userPrompt).toContain('"stage": "own_goals"');
    const seen = JSON.stringify(payload);
    for (const s of c.shows) expect(seen, `review should show ${s}`).toContain(s);
  });

  it("good reply: the right call, and the server lets it through", () => {
    const o = run(c, c.good);
    expect(o.parsed.ok).toBe(true);
    expect(c.judge(o)).toEqual([]);
    expect(c.safety(o)).toEqual([]);
  });

  it("bad reply: the judge catches it", () => {
    expect(c.judge(run(c, c.bad)).length).toBeGreaterThan(0);
  });

  if (c.knownGap) {
    it(`bad reply: KNOWN GAP, the server does not hold it yet (${c.knownGap})`, () => {
      expect(c.safety(run(c, c.bad)).length).toBeGreaterThan(0);
    });
  } else {
    it("bad reply: the server holds, whatever the model said", () => {
      expect(c.safety(run(c, c.bad))).toEqual([]);
    });
  }
});

describe("decision replay: what the server does with specific bad moves", () => {
  const byId = (id: string) => REPLAY_CASES.find((c) => c.id === id)!;

  it("awareness pause: the cut order is refused on its evidence (S4), and the channel pause becomes a question", () => {
    const c = byId("awareness-zero-bookings");
    const o = run(c, c.bad);
    expect(o.applied.some((a) => a.kind === "channel_paused" || a.kind === "dispatch")).toBe(false);
    expect(o.refused.some((r) => /not judged yet.*built for reach/.test(r))).toBe(true);
    expect(o.held.some((h) => h.reasons.includes("paid_channel_pause_needs_founder"))).toBe(true);
  });

  it("R1: a pause card that does reach the door is held for the founder with its numbers on the card, not in a question", () => {
    const c = byId("awareness-zero-bookings");
    const { payload } = buildReview(c.world);
    const o = replayApply(c.world, payload, c.good, [
      { name: "mcp__server__meta_ads__propose_status_change", input: { object_id: "120210000000000001", level: "campaign", status: "PAUSED" } },
    ]);
    const held = o.held.find((h) => h.reasons.includes("pause_needs_founder"));
    expect(held?.evidence).toContain("Last 7 days: $140 spent, 0 conversions; not set up to optimise for conversions, so judged on its own objective.");
    expect(o.questions.some((q) => q.topic_key.startsWith("held:"))).toBe(false);
  });

  it("S4: the two tried-organic pauses are held on evidence, and a quiet founder is never grounds", () => {
    const blog = run(byId("organic-insufficient-evidence"), byId("organic-insufficient-evidence").bad);
    expect(blog.held.some((h) => h.reasons.includes("insufficient_evidence"))).toBe(true);
    const quiet = run(byId("quiet-founder-no-pause"), byId("quiet-founder-no-pause").bad);
    expect(quiet.held.some((h) => h.verdict === "deny" && h.reasons.includes("founder_silence_not_grounds"))).toBe(true);
  });

  it("R2: an organic move is dispatched for drafts; its post waits for the founder's click", () => {
    const c = byId("organic-direction");
    const o = run(c, c.good);
    expect(o.applied).toContainEqual(expect.objectContaining({ kind: "dispatch", target: "x_organic" }));
    expect(o.held).toContainEqual({ what: "X post: how Phoenix hosts earned $1,900 in September", verdict: "deny", reasons: ["publish_needs_founder"] });
  });

  it("id-only payload: the raise is held on the open rebuild card; approving the rebuild re-dispatches it", () => {
    const c = byId("id-only-advice-match");
    const bad = run(c, c.bad);
    expect(bad.refused.some((r) => /open card "Rebuild \"40% to Turo\"/.test(r))).toBe(true);
    expect(bad.left).toEqual([]);
    const good = run(c, c.good);
    expect(good.applied).toContainEqual(expect.objectContaining({ kind: "dispatch", target: "meta_ads", origin_action_id: "ca-turo-rebuild2" }));
    expect(good.left).toEqual(["Left for you: Raise ad set budget from $40 to $60/day, because More money into a traffic campaign that Meta Ads wants rebuilt makes no sense yet."]);
  });

  it("open rebuild card: a move naming its object is refused and the founder is asked; approving it re-dispatches the channel", () => {
    const c = byId("open-rebuild-card");
    const bad = run(c, c.bad);
    expect(bad.applied.some((a) => a.kind === "dispatch")).toBe(false);
    expect(bad.refused.some((r) => /names the object of the channel's open card/.test(r))).toBe(true);
    const good = run(c, c.good);
    expect(good.applied).toContainEqual(expect.objectContaining({ kind: "dispatch", target: "meta_ads", origin_action_id: "ca-turo-rebuild" }));
  });

  it("each held money move names the S1 rule that held it", () => {
    const reasonOf = (id: string) => run(byId(id), byId(id).bad).held.flatMap((h) => h.reasons);
    expect(reasonOf("learning-no-cut")).toContain("learning_lock");
    expect(reasonOf("tracking-broken-no-cpa-call")).toContain("tracking_broken");
    expect(reasonOf("spend-below-floor")).toContain("spend_below_floor");
    expect(reasonOf("founder-paused-by-hand")).toContain("founder_paused_it");
    expect(reasonOf("google-bid-change-to-founder")).toContain("class_not_on_unattended_list");
    expect(reasonOf("google-remove-never")).toContain("delete_never_unattended");
    expect(reasonOf("paid-pause-card-to-founder")).toContain("pause_needs_founder");
    expect(run(byId("stale-typed-goal-number"), byId("stale-typed-goal-number").bad).applied.some(a=>a.kind==="ad_change")).toBe(true);
  });

  it("positive cases: the server applies the right growth move", () => {
    const up = (id: string) => run(byId(id), byId(id).good).applied.filter((a) => a.kind === "ad_change" && a.direction === "up");
    expect(up("resume-inside-budget")).toHaveLength(1);
    expect(up("scale-converting-past-learning")).toHaveLength(1);
    expect(up("scale-working-google")).toHaveLength(1);
    expect(up("contradicting-cards")).toHaveLength(1);
  });

  it("an unparseable reply applies nothing", () => {
    const c = byId("awareness-zero-bookings");
    const o = run(c, "I think we should pause it.");
    expect(o.parsed.ok).toBe(false);
    expect(o.applied).toEqual([]);
    expect(c.judge(o).length).toBeGreaterThan(0);
  });

  it("a direct Meta pause tool call (live mode) is held like any other pause", () => {
    const c = byId("awareness-zero-bookings");
    const { payload } = buildReview(c.world);
    const o = replayApply(c.world, payload, c.good, [
      { name: "mcp__server__meta_ads__propose_status_change", input: { object_id: "120210000000000001", level: "campaign", status: "PAUSED" } },
    ]);
    expect(o.applied.some((a) => a.kind === "ad_change")).toBe(false);
    expect(o.held.some((h) => h.reasons.includes("pause_needs_founder"))).toBe(true);
    expect(c.judge(o).length).toBeGreaterThan(0);
  });

  it("direct Meta tool calls use the tool's own field names, and a dry_run preview is not a write", () => {
    const c = { ...byId("scale-converting-past-learning") };
    c.world = { ...c.world, cards: [] };
    const { payload } = buildReview(c.world);
    const up = replayApply(c.world, payload, c.bad, [
      { name: "meta_ads__propose_budget_change", input: { ad_set_id: "120210000000000082", current_daily_budget_usd: 30, proposed_daily_budget_usd: 45 } },
    ]);
    expect(up.applied).toContainEqual(expect.objectContaining({ kind: "ad_change", via: "tool", direction: "up" }));
    const preview = replayApply(c.world, payload, c.bad, [
      { name: "meta_ads__propose_status_change", input: { object_id: "120210000000000081", level: "campaign", status: "PAUSED", dry_run: true } },
    ]);
    expect(preview.applied.some((a) => a.kind === "ad_change")).toBe(false);
    expect(preview.held).toEqual([]);
  });

  it("the review stays inside the evidence size budget on every case", () => {
    for (const c of REPLAY_CASES) {
      const ev = (buildReview(c.world).payload as { memory: { cgo_goals: { evidence?: unknown } } }).memory.cgo_goals.evidence;
      expect(JSON.stringify(ev ?? {}).length).toBeLessThanOrEqual(6000);
    }
  });
});

describe("decision replay: the live runner (scripted model)", () => {
  it("pass^k: every attempt must pass; a failed call is an error, never a pass", async () => {
    const { runReplayCases, replayReport } = await import("../replay-run");
    const c = REPLAY_CASES.find((x) => x.id === "awareness-zero-bookings")!;
    let n = 0;
    const results = await runReplayCases({
      cases: [c],
      k: 3,
      systemPrompt: async () => "sys",
      call: async () => {
        n++;
        if (n === 2) return { text: c.bad, toolCalls: [], tokens: 1, costUsd: 0.5 };
        if (n === 3) throw new Error("boom");
        return { text: c.good, toolCalls: [], tokens: 1, costUsd: 0.5 };
      },
    });
    expect(results[0].pass).toBe(false);
    expect(results[0].attempts.map((a) => a.pass)).toEqual([true, false, false]);
    expect(results[0].attempts[2].error).toBe("boom");
    expect(results[0].costUsd).toBe(1);
    expect(replayReport(results, 3, "m")).toContain("| awareness-zero-bookings | FAIL |");
  });
});

describe("decision replay: the note as items", () => {
  const byId = (id: string) => REPLAY_CASES.find((c) => c.id === id)!;

  it("every case's outcome carries items", () => {
    for (const c of REPLAY_CASES) expect(Array.isArray(run(c, c.good).items), c.id).toBe(true);
  });

  it("a card cgo leaves is one Needs you item, with cgo's why", () => {
    const o = run(byId("awareness-card-sent-back"), byId("awareness-card-sent-back").good);
    expect(o.items).toEqual([
      expect.objectContaining({ section: "needs_you", action_id: "ca-aware-pause", channel_slug: "meta_ads", reason: "It is built for reach, so zero purchases says nothing about it" }),
    ]);
  });

  it("an executable approve is Working on (Applying:), never What I changed: the replay does not execute", () => {
    const c = byId("scale-converting-past-learning");
    const o = run(c, c.good);
    expect(o.items.find((i) => i.action_id === "ca-sf-up")).toMatchObject({ section: "working_on", text: expect.stringMatching(/^Applying: /) });
    expect(o.items.some((i) => i.section === "changed")).toBe(false);
  });

  it("a card the platform refused, left by the model, is Blocked on us; two cards in one chain are one item", () => {
    const base = byId("awareness-card-sent-back");
    const world = {
      ...base.world,
      cards: [
        ...base.world.cards,
        {
          id: "ca-yt-1",
          channel_slug: "youtube_ads",
          title: "Create “Upcar - YouTube - Bay Area - zavi-brief-18df3c487111”",
          exec_class: "google_ads.create_campaign",
          exec_payload: { name: "Upcar - YouTube - Bay Area" },
          exec_status: "failed",
          exec_result: { error: 'Google Ads create failed: 400 {"errorCode": {"mutateError": "MUTATE_NOT_ALLOWED"}}' },
          proposed_days_ago: 2,
        },
        { id: "ca-yt-2", channel_slug: "youtube_ads", title: "Create the Bay Area YouTube campaign again", exec_class: "google_ads.create_campaign", exec_payload: { name: "Upcar - YouTube - Bay Area" }, exec_status: "failed", exec_result: { bucket: "blocked_on_us" }, repeat_of: "ca-yt-1", proposed_days_ago: 1 },
      ],
    };
    const { payload } = buildReview(world);
    const o = replayApply(
      world,
      payload,
      `<goal_moves>${JSON.stringify({
        channel_cards: [
          { action_id: "ca-yt-1", decision: "leave", why: "Google turned it down" },
          { action_id: "ca-yt-2", decision: "approve", why: "try again" },
          { action_id: "ca-aware-pause", decision: "leave", why: "Built for reach." },
        ],
      })}</goal_moves>`,
    );
    const yt = o.items.filter((i) => i.channel_slug === "youtube_ads");
    expect(yt).toEqual([
      expect.objectContaining({ section: "blocked", action_id: "ca-yt-1", chain_root_id: "ca-yt-1", text: "Create “Upcar - YouTube - Bay Area”", reason: "Google Ads refused this change. We've been alerted; nothing for you to do" }),
    ]);
    expect(o.items.some((i) => i.section === "needs_you" && i.channel_slug === "youtube_ads")).toBe(false);
    expect(o.applied.some((a) => a.kind === "ad_change")).toBe(false);
  });
});
