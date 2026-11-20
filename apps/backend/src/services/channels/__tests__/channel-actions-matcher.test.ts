import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));
vi.mock("@/services/analytics/mixpanel", () => ({ track: vi.fn() }));

import { stepDecisionBodies } from "@/agents/lib/channel-recipe-step";
import { recordChannelRunActions, type ScoreContext } from "../channel-actions";
import type { MatchVerdict, PoolCard } from "../card-matcher";
import type { OpenCard } from "../supersede-actions";

const CTX: ScoreContext = {
  channel_in_plan: true,
  goal_metric_keys: new Set(),
  rejected_title_keys: new Set(),
  rejected_ids: new Set(),
};

const step = (title: string, extra: Record<string, unknown> = {}) => ({
  title,
  body: `why ${title}`,
  blocking: false,
  effort: "minutes",
  evidence: ["e"],
  ...extra,
});

const ENVELOPE = {
  rendered_markdown: "r",
  steps: [
    step("Update your LinkedIn headline"),
    step("Comment on a founder's post"),
    step("Post the launch story", { repeat_of: "11111111-2222-3333-4444-555555555555" }),
  ],
};

const POOL: PoolCard[] = [
  { id: "open-li", channel: "linkedin_organic", status: "open", title: "Replace your LinkedIn headline", summary: "" },
];

function fakeRpc() {
  return vi.fn(async (_tid: unknown, name: string, args: Record<string, unknown>) => {
    if (name === "record_channel_run_actions") {
      const actions = args.p_actions as Array<{ position: number }>;
      return {
        data: { inserted: actions.length, metrics: 0, stale_accepted: 0, stale_dropped: 0, ids: actions.map((a) => ({ position: a.position, id: `id-${a.position}` })) },
        error: null,
      };
    }
    return { data: { displaced: 0 }, error: null };
  });
}

const OLD_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

it.each([true, false])("keeps all requested bio alternatives despite an acted bio, while ordinary runs still match (requested=%s)", async (requested) => {
  const parts = [
    { label: "Bio A", content: "Handmade cups for your daily coffee. Shop the collection." },
    { label: "Bio B", content: "Make your coffee ritual yours. Explore handmade cups." },
    { label: "Bio C", content: "A handmade cup for every morning. Find your favourite." },
  ];
  const envelope = { rendered_markdown: "Choose one bio.", steps: [step("Choose your Instagram bio", {
    deliverable: { kind: "page_copy", label: "Instagram bios", content: parts[0].content, parts },
  })] };
  const rpc = fakeRpc();
  const loadMatchPool = vi.fn(async () => [{ id: OLD_ID, channel: "instagram_organic", status: "acted" as const, title: "Choose your Instagram bio", summary: "Update the bio" }]);
  const matchCards = vi.fn(async () => ({ verdicts: [{ ref: "n0", decision: "already_done", match_id: OLD_ID, changed: false, reason: "Same profile update" }], input_tokens: 1, output_tokens: 1 }));
  await recordChannelRunActions({
    tenantId: "t-1", runId: "bio-run", channelSlug: "instagram_organic", envelope,
    bodies: stepDecisionBodies(envelope as never), redo: null,
    ...(requested ? { topAction: "rewrite_bio" as const } : {}),
  }, {
    rpc: rpc as never, loadScoreContext: async () => CTX, stagedPosts: async () => [],
    listOpen: (async () => ({ actions: [], more: 0 })) as never,
    loadMatchPool, matchCards: matchCards as never, siteBuilder: async () => "unknown",
  });
  const actions = rpc.mock.calls.find((c) => c[1] === "record_channel_run_actions")![2].p_actions as Array<Record<string, unknown>>;
  if (!requested) {
    expect(matchCards).toHaveBeenCalledTimes(1);
    expect(actions).toHaveLength(0);
    return;
  }
  expect(loadMatchPool).not.toHaveBeenCalled();
  expect(matchCards).not.toHaveBeenCalled();
  expect(actions).toHaveLength(1);
  expect(actions[0]).toMatchObject({
    action_type: "fix", card_kind: "copy_to_site", primary_label: "Copy new text", done_label: "I updated the page",
    body: { step: { deliverable: { kind: "page_copy", content: parts[0].content, parts } } },
  });
  expect(actions[0].how_to).toContain("Open the Instagram app and find the text this card names.");
});

const openCard = (over: Partial<OpenCard> = {}): OpenCard => ({
  id: OLD_ID,
  run_id: "run-0",
  status: "pending",
  exec_status: null,
  approved_by: null,
  steps_done: null,
  edited_body: null,
  exec_class: null,
  customer: true,
  ...over,
});

async function runFull(
  matchCards: (...a: unknown[]) => Promise<unknown>,
  pool: PoolCard[] = POOL,
  opts: { open?: OpenCard[]; envelope?: Record<string, unknown> } = {},
) {
  const rpc = fakeRpc();
  const envelope = opts.envelope ?? ENVELOPE;
  await recordChannelRunActions(
    { tenantId: "t-1", runId: "run-1", channelSlug: "linkedin_organic", envelope, bodies: stepDecisionBodies(envelope as never), redo: null },
    {
      rpc: rpc as never,
      loadScoreContext: async () => CTX,
      stagedPosts: async () => [],
      listOpen: (async () => ({ actions: [], more: 0 })) as never,
      loadOpenCards: async (_t, _c, ids) => (opts.open ?? []).filter((o) => ids.includes(o.id)),
      loadMatchPool: async () => pool,
      matchCards: matchCards as never,
    },
  );
  const call = rpc.mock.calls.find((c) => c[1] === "record_channel_run_actions")!;
  return {
    actions: call[2].p_actions as Array<{ title: string; repeat_of: string | null }>,
    stale: call[2].p_stale as Array<{ action_id: string; evidence: string }>,
  };
}

async function run(matchCards: (...a: unknown[]) => Promise<unknown>, pool: PoolCard[] = POOL) {
  return (await runFull(matchCards, pool)).actions.map((a) => a.title);
}

const REPLACE_POOL: PoolCard[] = [
  { id: OLD_ID, channel: "linkedin_organic", status: "open", title: "Replace your LinkedIn headline", summary: "" },
];
const replaceVerdicts = async () => ({
  verdicts: [verdict("n0", "same_open", OLD_ID), verdict("n1", "new")],
  input_tokens: 1,
  output_tokens: 1,
});

const verdict = (ref: string, decision: MatchVerdict["decision"], match_id: string | null = null): MatchVerdict => ({
  ref,
  decision,
  match_id,
  changed: false,
  reason: "",
});

describe("recordChannelRunActions with the card matcher", () => {
  it("newest wins: the same work as an untouched open card replaces it (repeat_of + stale flag)", async () => {
    const { actions, stale } = await runFull(replaceVerdicts, REPLACE_POOL, { open: [openCard()] });
    expect(actions.map((a) => a.title)).toEqual([
      "Update your LinkedIn headline",
      "Comment on a founder's post",
      "Post the launch story",
    ]);
    expect(actions[0].repeat_of).toBe(OLD_ID);
    expect(stale).toEqual([{ action_id: OLD_ID, evidence: "Replaced by a newer card: Update your LinkedIn headline" }]);
  });

  it("the replaced count is the matcher replacements that landed, not sent minus every refusal", async () => {
    const { logEvent } = await import("@/services/logging/logEvent");
    vi.mocked(logEvent).mockClear();
    const rpc = vi.fn(async (_tid: unknown, name: string, args: Record<string, unknown>) => {
      if (name === "record_channel_run_actions") {
        const actions = args.p_actions as Array<{ position: number; title: string }>;
        const landed = actions.filter((a) => a.title !== "Post the launch story");
        return {
          data: { inserted: landed.length, metrics: 0, stale_accepted: 1, stale_dropped: 0, replacements_refused: 1, ids: landed.map((a) => ({ position: a.position, id: `id-${a.position}` })) },
          error: null,
        };
      }
      return { data: { displaced: 0 }, error: null };
    });
    await recordChannelRunActions(
      { tenantId: "t-1", runId: "run-1", channelSlug: "linkedin_organic", envelope: ENVELOPE, bodies: stepDecisionBodies(ENVELOPE as never), redo: null },
      {
        rpc: rpc as never,
        loadScoreContext: async () => CTX,
        stagedPosts: async () => [],
        listOpen: (async () => ({ actions: [], more: 0 })) as never,
        loadOpenCards: async (_t, _c, ids) => [openCard()].filter((o) => ids.includes(o.id)),
        loadMatchPool: async () => REPLACE_POOL,
        matchCards: replaceVerdicts as never,
      },
    );
    const recorded = vi.mocked(logEvent).mock.calls.find((c) => c[0].code === "channel.actions_recorded");
    expect(recorded?.[0].message).toContain("replaced=1 replacements_refused=1");
  });

  it.each([
    ["edited by the founder", { edited_body: { title: "x" } }],
    ["a step ticked", { steps_done: [0] }],
    ["an executable card", { exec_class: "meta_ads.pause_ad" }],
    ["on the other side of the customer split", { customer: false }],
  ])("the old card stays and the new one is dropped when the old card is %s", async (_label, over) => {
    const { actions, stale } = await runFull(replaceVerdicts, REPLACE_POOL, { open: [openCard(over as Partial<OpenCard>)] });
    expect(actions.map((a) => a.title)).toEqual(["Comment on a founder's post", "Post the launch story"]);
    expect(stale).toEqual([]);
  });

  it.each([
    ["an executable card", { exec_class: "meta_ads.pause_ad" }],
    ["a step ticked", { steps_done: [0] }],
  ])("the model's own stale flag cannot retire a replaced card the guards kept (%s)", async (_label, over) => {
    const envelope = { ...ENVELOPE, stale: [{ action_id: OLD_ID, evidence: "old" }] };
    const { actions, stale } = await runFull(replaceVerdicts, REPLACE_POOL, { open: [openCard(over as Partial<OpenCard>)], envelope });
    expect(actions.map((a) => a.title)).toEqual(["Comment on a founder's post", "Post the launch story"]);
    expect(stale.some((x) => x.action_id === OLD_ID)).toBe(false);
  });

  it("the old card stays and the new one is dropped when the old card is not loadable (snoozed, approved, exec row)", async () => {
    const { actions, stale } = await runFull(replaceVerdicts, REPLACE_POOL, { open: [] });
    expect(actions.map((a) => a.title)).toEqual(["Comment on a founder's post", "Post the launch story"]);
    expect(stale).toEqual([]);
  });

  it("the new card is dropped when the stale cap cuts its retirement", async () => {
    const full = Array.from({ length: 30 }, (_x, i) => ({
      action_id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
      evidence: "old",
    }));
    const envelope = { ...ENVELOPE, stale: full };
    const { actions, stale } = await runFull(replaceVerdicts, REPLACE_POOL, { open: [openCard()], envelope });
    expect(actions.map((a) => a.title)).toEqual(["Comment on a founder's post", "Post the launch story"]);
    expect(stale.some((x) => x.action_id === OLD_ID)).toBe(false);
  });

  it("done and rejected repeats are still dropped", async () => {
    const titles = await run(async () => ({
      verdicts: [
        { ...verdict("n0", "already_done", "done-1"), changed: false },
        { ...verdict("n1", "already_rejected", "rej-1"), changed: false },
      ],
      input_tokens: 1,
      output_tokens: 1,
    }));
    expect(titles).toEqual(["Post the launch story"]);
  });

  it("never sends a card that names what it replaces (repeat_of) to the matcher", async () => {
    const matchCards = vi.fn(async () => null);
    await run(matchCards);
    const fresh = (matchCards.mock.calls[0] as unknown[])[1] as Array<{ title: string }>;
    expect(fresh.map((f) => f.title)).toEqual(["Update your LinkedIn headline", "Comment on a founder's post"]);
  });

  it("fails open: no answer writes every card", async () => {
    expect(await run(async () => null)).toHaveLength(3);
  });

  it("an empty pool still checks the run's own cards against each other", async () => {
    const titles = await run(
      async () => ({ verdicts: [verdict("n0", "new"), verdict("n1", "same_new", "n0")], input_tokens: 1, output_tokens: 1 }),
      [],
    );
    expect(titles).toEqual(["Update your LinkedIn headline", "Post the launch story"]);
  });

  it("the kill switch writes every card without asking", async () => {
    const matchCards = vi.fn(async () => null);
    process.env.CHANNEL_CARD_MATCHER = "0";
    try {
      expect(await run(matchCards)).toHaveLength(3);
      expect(matchCards).not.toHaveBeenCalled();
    } finally {
      delete process.env.CHANNEL_CARD_MATCHER;
    }
  });
});

describe("recordChannelRunActions snapshot and re-match", () => {
  const TARGETED = {
    rendered_markdown: "r",
    steps: [
      step("Update your LinkedIn headline", { target: { kind: "profile", ref: "@Ravi" } }),
      step("Comment on a founder's post", { target: { kind: "post", ref: "https://linkedin.com/posts/abc/" } }),
      step("Clear your pending approvals", { target: { kind: "queue", ref: "approvals" } }),
    ],
  };
  const SAME_PROFILE: PoolCard = { id: "33333333-3333-4333-8333-333333333333", channel: "linkedin_organic", status: "open", title: "Refresh your headline", summary: "", target: { kind: "profile", ref: "ravi" } };
  const OTHER: PoolCard = { id: "44444444-4444-4444-8444-444444444444", channel: "linkedin_organic", status: "open", title: "Other", summary: "", target: { kind: "page", ref: "/x" } };
  const allNew = async (_c: unknown, fresh: Array<{ ref: string }>) => ({ verdicts: fresh.map((f) => verdict(f.ref, "new")), input_tokens: 1, output_tokens: 1 });

  type Sent = Array<{ position: number; title: string; target_key: string | null; judged_ids: string[] | null; repeat_of: string | null; repeat_matched: boolean }>;
  async function runRpc(rpcAnswers: Array<(actions: Sent) => unknown>, deps: Record<string, unknown> = {}) {
    const calls: Sent[] = [];
    const rpc = vi.fn(async (_tid: unknown, name: string, args: Record<string, unknown>) => {
      if (name === "record_channel_run_actions") {
        const actions = args.p_actions as Sent;
        calls.push(actions);
        const answer = rpcAnswers[Math.min(calls.length - 1, rpcAnswers.length - 1)];
        return { data: answer(actions), error: null };
      }
      if (name === "enqueue_ops_alert") return { data: true, error: null };
      return { data: { displaced: 0 }, error: null };
    });
    const result = await recordChannelRunActions(
      { tenantId: "t-1", runId: "run-1", channelSlug: "linkedin_organic", envelope: TARGETED, bodies: stepDecisionBodies(TARGETED as never), redo: null },
      {
        rpc: rpc as never,
        loadScoreContext: async () => CTX,
        stagedPosts: async () => [],
        listOpen: (async () => ({ actions: [], more: 0 })) as never,
        loadOpenCards: async () => [],
        loadMatchPool: async () => [SAME_PROFILE, OTHER],
        matchCards: allNew as never,
        ...deps,
      },
    );
    return { calls, rpc, result };
  }
  const landed = (actions: Sent) => ({ inserted: actions.length, metrics: 0, stale_accepted: 0, stale_dropped: 0, ids: actions.map((a) => ({ position: a.position, id: `id-${a.position}` })) });

  it("each card carries its target_key and the open pool cards on that target it was judged against", async () => {
    const loadMatchPool = vi.fn(async () => [SAME_PROFILE, OTHER]);
    const { calls } = await runRpc([landed], { loadMatchPool });
    expect(loadMatchPool).toHaveBeenCalledWith("t-1", "linkedin_organic", expect.any(Number), ["profile:ravi", "post:/posts/abc"]);
    const [a, b, q] = calls[0];
    expect(a).toMatchObject({ target_key: "profile:ravi", judged_ids: [SAME_PROFILE.id], repeat_matched: false });
    expect(b).toMatchObject({ target_key: "post:/posts/abc", judged_ids: [] });
    expect(q).toMatchObject({ target_key: null, judged_ids: null });
  });

  it("a matcher replacement is marked repeat_matched", async () => {
    const replace = async (_c: unknown, fresh: Array<{ ref: string }>) => ({
      verdicts: fresh.map((f) => (f.ref === "n0" ? verdict("n0", "same_open", SAME_PROFILE.id) : verdict(f.ref, "new"))),
      input_tokens: 1,
      output_tokens: 1,
    });
    const { calls } = await runRpc([landed], {
      matchCards: replace,
      loadOpenCards: async () => [openCard({ id: SAME_PROFILE.id })],
    });
    expect(calls[0][0]).toMatchObject({ repeat_of: SAME_PROFILE.id, repeat_matched: true });
  });

  it("{rematch, positions} -> one re-match on a fresh pool, then the resubmit lands", async () => {
    const loadMatchPool = vi.fn(async () => [SAME_PROFILE, OTHER]);
    const { calls, result } = await runRpc([() => ({ rematch: true, positions: [2] }), landed], { loadMatchPool });
    expect(calls).toHaveLength(2);
    expect(loadMatchPool).toHaveBeenCalledTimes(2);
    expect(result.inserted).toBe(3);
  });

  it("a second rematch lets only the contested cards through unjudged, alerted once", async () => {
    const { logEvent } = await import("@/services/logging/logEvent");
    vi.mocked(logEvent).mockClear();
    const { calls, rpc, result } = await runRpc([
      () => ({ rematch: true, positions: [1] }),
      () => ({ rematch: true, positions: [1] }),
      landed,
    ]);
    expect(calls).toHaveLength(3);
    expect(calls[2].find((a) => a.position === 1)).toMatchObject({ judged_ids: null, repeat_matched: false });
    expect(calls[2].find((a) => a.position === 2)).toMatchObject({ judged_ids: [] });
    const alerts = rpc.mock.calls.filter((c) => c[1] === "enqueue_ops_alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0][2]).toMatchObject({ p_dedupe_key: "rematch:run-1", p_code: "rematch_exhausted" });
    expect(vi.mocked(logEvent).mock.calls.some((c) => c[0].code === "channel.card_rematch_exhausted")).toBe(true);
    expect(result.inserted).toBe(3);
  });

  it("exhaustion drops a contested card's matcher replacement: no repeat_of, no supersede flag", async () => {
    const replace = async (_c: unknown, fresh: Array<{ ref: string }>) => ({
      verdicts: fresh.map((f) => (f.ref === "n0" ? verdict("n0", "same_open", SAME_PROFILE.id) : verdict(f.ref, "new"))),
      input_tokens: 1,
      output_tokens: 1,
    });
    const staleSent: unknown[][] = [];
    const { calls, rpc } = await runRpc(
      [() => ({ rematch: true, positions: [1] }), () => ({ rematch: true, positions: [1] }), landed],
      { matchCards: replace, loadOpenCards: async () => [openCard({ id: SAME_PROFILE.id })] },
    );
    for (const c of rpc.mock.calls) if (c[1] === "record_channel_run_actions") staleSent.push(c[2].p_stale as unknown[]);
    expect(calls[1][0]).toMatchObject({ repeat_of: SAME_PROFILE.id, repeat_matched: true });
    expect(staleSent[1]).toEqual([{ action_id: SAME_PROFILE.id, evidence: expect.any(String) }]);
    expect(calls[2][0]).toMatchObject({ repeat_of: null, repeat_matched: false, judged_ids: null });
    expect(staleSent[2]).toEqual([]);
  });

  it("a re-match that names no new position stops instead of looping", async () => {
    await expect(
      runRpc([() => ({ rematch: true, positions: [1] }), () => ({ rematch: true, positions: [1] }), () => ({ rematch: true, positions: [1] })]),
    ).rejects.toThrow(/no new position/);
  });

  it("a failed pool read or judge sends no snapshot (fail open)", async () => {
    const failed = Object.assign([SAME_PROFILE], { readFailed: true as const });
    const r1 = await runRpc([landed], { loadMatchPool: async () => failed });
    expect(r1.calls[0].map((a) => a.judged_ids)).toEqual([null, null, null]);
    const r2 = await runRpc([landed], { matchCards: async () => null });
    expect(r2.calls[0][0].judged_ids).toBeNull();
  });

  it("kept cards come back apart from the ids that landed", async () => {
    const { result } = await runRpc([
      (actions: Sent) => ({
        inserted: 2,
        metrics: 0,
        stale_accepted: 0,
        stale_dropped: 0,
        replacements_refused: 1,
        ids: [{ position: 1, id: SAME_PROFILE.id, kept: true }, ...actions.slice(1).map((a) => ({ position: a.position, id: `id-${a.position}` }))],
      }),
    ]);
    expect(result.kept).toEqual([{ position: 1, id: SAME_PROFILE.id }]);
    expect(result.ids.map((r) => r.position)).toEqual([2, 3]);
  });
});

it.each([false, true])("files three posts and retires only an explicitly replaced untouched draft (edited=%s)", async edited => {
  const envelope = {rendered_markdown:"Three finished drafts.",steps:[
    step("First post",{repeat_of:OLD_ID,deliverable:{kind:"post",label:"First",content:"First finished post."}}),
    step("Second post",{deliverable:{kind:"post",label:"Second",content:"Second finished post."}}),
    step("Third post",{deliverable:{kind:"post",label:"Third",content:"Third finished post."}}),
  ]};
  const result = await runFull(async()=>({verdicts:[],input_tokens:0,output_tokens:0}), [], {envelope,open:[openCard({edited_body:edited?{text:"Founder edit"}:null})]});
  expect(result.actions).toHaveLength(3);
  expect(result.stale.map(x=>x.action_id)).toEqual(edited?[]:[OLD_ID]);
});
