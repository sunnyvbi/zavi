import { describe, it, expect, vi } from "vitest";
import { amountsIn, applyFounderReplyApprovals, applyFounderReplyWithoutReview, replyMatchesCard, replyPointsAt, replySaysYes, threadAnswer, type CardRow, type ReplyApprovalDeps } from "../founder-reply-approve";
import type { BudgetRaiseNeed } from "../ad-budget-shortfall";
import { cardChangeSentence } from "../card-change";

const T = "11111111-1111-4111-8111-111111111111";
const REPLY_RUN = "22222222-2222-4222-8222-222222222222";
const CARD = "33333333-3333-4333-8333-333333333333";
const CARD2 = "44444444-4444-4444-8444-444444444444";
const OWNER = "55555555-5555-4555-8555-555555555555";
const payload = { reason: "founder_reply", founder_reply: { via: "slack", reply_run_id: REPLY_RUN } };
const REPLY = "Go ahead and Raise Northwind Sales Search from $55 to $110/day";

const googleCard = (id = CARD, title = "Raise Northwind Sales Search from $55 to $110/day"): CardRow => ({
  id,
  run_id: null,
  channel_slug: "google_ads",
  title,
  exec_class: "google_ads.update_campaign_budget_review",
  exec_payload: { campaign_id: "c-1", daily_budget_usd: 110, expected_current_daily_budget_usd: 55, rationale: "", over_cap: true },
});
const metaCard = (id = CARD2): CardRow => ({
  id,
  run_id: null,
  channel_slug: "meta_ads",
  title: "Raise the Harbor Weekend ad set to $80/day",
  exec_class: "meta_ads.update_ad_set_budget",
  exec_payload: { ad_set_id: "as-1", daily_budget_usd: 80, expected_current_daily_budget_usd: 40, rationale: "", over_cap: false },
});
const item = (id: string, text: string, extra: Record<string, unknown> = {}) => ({ section: "needs_you", text, action_id: id, channel_slug: "google_ads", ...extra });

function withChange(items: unknown[], cards: Record<string, CardRow | null>): unknown[] {
  return items.map((raw) => {
    const i = raw as { action_id?: string; card_change?: string | null };
    const card = i.action_id ? cards[i.action_id] : null;
    if (!card || "card_change" in i) return i;
    const sentence = cardChangeSentence(card.exec_class, card.exec_payload);
    return sentence ? { ...i, card_change: sentence } : i;
  });
}

function setup(over: {
  reply?: string | null;
  via?: "slack" | "email";
  noteItems?: unknown[] | null;
  later?: unknown[][];
  cards?: Record<string, CardRow | null>;
  need?: BudgetRaiseNeed;
  raiseOk?: boolean;
  approveResult?: { ok: true; attempt: number; alreadyQueued: boolean; stillQueued?: boolean; replayed: boolean } | { ok: false; code: string };
  exec?: Array<{ id: string; exec_status: string | null; exec_result: unknown }>;
} = {}) {
  const calls = {
    raise: vi.fn(async (_t: string, _a: { actor: string; budget_id: string; monthly_usd: number; daily_limit_usd: number | null }) => over.raiseOk ?? true),
    approve: vi.fn(async (_t: string, _a: { actionId: string; eventKey: string; actorUserId: string }) => over.approveResult ?? { ok: true as const, attempt: 1, alreadyQueued: false, stillQueued: true, replayed: false }),
    send: vi.fn(async (_id: string, _attempt: number) => undefined),
    post: vi.fn(async (_a: { tenant_id: string; channel_id: string; thread_ts: string; team_id: string | null; body: string; key: string }) => undefined),
    log: vi.fn(async (_t: string, _m: Record<string, unknown>) => undefined),
  };
  const cards = over.cards ?? { [CARD]: googleCard() };
  const deps: ReplyApprovalDeps = {
    readReplyRun: async () => ({ trigger: over.via === "email" ? "email" : "slack", payload: { cgo_reply: { via: over.via ?? "slack" }, slack: { channel_id: "D1", thread_ts: "100.1", team_id: "T1" } } }),
    verifyFounder: async () => (over.reply === null ? null : { via: over.via ?? "slack", text: over.reply ?? REPLY, reply_run_id: REPLY_RUN }),
    readNote: async () => (over.noteItems === null ? null : { id: "n-1", created_at: "2026-10-07T14:44:00Z", items: withChange(over.noteItems ?? [item(CARD, "Raise Northwind Sales Search from $55 to $110/day")], cards) }),
    readReasks: async () => (over.later ?? []) as never,
    readCard: async (_t, id) => cards[id] ?? null,
    ownerId: async () => OWNER,
    budgetNeed: async () => over.need ?? { kind: "fits" },
    raiseBudget: calls.raise,
    approve: calls.approve,
    sendApproved: calls.send,
    readExec: async () => over.exec ?? [{ id: CARD, exec_status: "executed", exec_result: null }],
    postThread: calls.post,
    log: calls.log,
    sleep: async () => undefined,
    settleMs: 0,
  };
  const run = (wanted: Array<{ action_id: string; decision: string }> = [{ action_id: CARD, decision: "approve" }], p: unknown = payload) =>
    applyFounderReplyApprovals({ tenant_id: T, payload: p, wanted }, deps);
  return { run, calls, deps };
}
const NEEDS = (to = 26021): BudgetRaiseNeed => ({ kind: "needs_raise", budget_id: "b-1", from_usd: 25000, to_usd: to, daily_limit_usd: 900 });

describe("the founder's yes approves the card as the founder", () => {
  it("MUST CATCH: the reply to a note that stated the new monthly budget raises it to that number, then approves with no source", async () => {
    const s = setup({ need: NEEDS(26021), noteItems: [item(CARD, "Raise Northwind Sales Search from $55 to $110/day", { budget_from_usd: 25000, budget_to_usd: 26100 })] });
    const out = await s.run();
    expect(s.calls.raise).toHaveBeenCalledWith(T, { actor: OWNER, budget_id: "b-1", monthly_usd: 26100, daily_limit_usd: 900 });
    expect(s.calls.approve).toHaveBeenCalledWith(T, { actionId: CARD, eventKey: `cgo-reply:${REPLY_RUN}:${CARD}`, actorUserId: OWNER });
    expect(s.calls.send).toHaveBeenCalledWith(CARD, 1);
    expect(out.handled.has(CARD)).toBe(true);
    expect(out.ad_changed).toBe(true);
    expect(out.unfulfilled).toBe(false);
    expect(out.items[0]).toMatchObject({ section: "working_on", approved: true, action_id: CARD });
    await out.settleAndAnswer();
    expect(s.calls.post.mock.calls[0][0]).toMatchObject({ channel_id: "D1", thread_ts: "100.1", key: `cgo_reply_result:${REPLY_RUN}` });
    expect(s.calls.post.mock.calls[0][0].body).toBe("Done: Raise Northwind Sales Search from $55 to $110/day. Your monthly ad budget is now $26,100.");
  });

  it("approves a card that fits with no budget change, and a Meta ad set the same way", async () => {
    const s = setup({ cards: { [CARD2]: metaCard() }, noteItems: [item(CARD2, "Raise the Harbor Weekend ad set to $80/day", { channel_slug: "meta_ads" })], reply: "yes" });
    const out = await s.run([{ action_id: CARD2, decision: "approve" }]);
    expect(s.calls.raise).not.toHaveBeenCalled();
    expect(s.calls.approve).toHaveBeenCalledTimes(1);
    expect(out.handled.has(CARD2)).toBe(true);
  });

  it("one card and a plain yes approves it even when the model did not pick it", async () => {
    const s = setup({ reply: "ok do it" });
    await s.run([]);
    expect(s.calls.approve).toHaveBeenCalledTimes(1);
  });

  it("MUST CATCH 2: no number was stated and the month is short -> nothing changes, the note and thread ask with the number", async () => {
    const s = setup({ need: NEEDS(26021) });
    const out = await s.run();
    expect(s.calls.raise).not.toHaveBeenCalled();
    expect(s.calls.approve).not.toHaveBeenCalled();
    expect(out.handled.has(CARD)).toBe(true);
    expect(out.unfulfilled).toBe(true);
    expect(out.items[0]).toMatchObject({ section: "needs_you", action_id: CARD, budget_from_usd: 25000, budget_to_usd: 26021 });
    await out.settleAndAnswer();
    expect(s.calls.post.mock.calls[0][0].body).toContain("needs your monthly ad budget at $26,021 now (it is $25,000). Nothing changed yet.");
  });

  it("a yes to a re-ask cgo posted in this same conversation is read against that number", async () => {
    const s = setup({ need: NEEDS(26021), later: [[item(CARD, "Raise Northwind Sales Search", { budget_from_usd: 25000, budget_to_usd: 26021 })]] });
    await s.run();
    expect(s.calls.raise).toHaveBeenCalledWith(T, expect.objectContaining({ monthly_usd: 26021 }));
    expect(s.calls.approve).toHaveBeenCalledTimes(1);
  });

  it("a stated number that no longer covers the raise changes nothing and re-asks", async () => {
    const s = setup({ need: NEEDS(27000), noteItems: [item(CARD, "Raise Northwind Sales Search", { budget_from_usd: 25000, budget_to_usd: 26021 })] });
    const out = await s.run();
    expect(s.calls.raise).not.toHaveBeenCalled();
    expect(s.calls.approve).not.toHaveBeenCalled();
    expect(out.items[0]).toMatchObject({ budget_to_usd: 27000 });
  });

  it("the same reply applied twice approves once: a replay tells and logs nothing more", async () => {
    const s = setup({ approveResult: { ok: true, attempt: 1, alreadyQueued: false, stillQueued: false, replayed: true } });
    const out = await s.run();
    expect(out.handled.has(CARD)).toBe(true);
    expect(out.items).toEqual([]);
    expect(s.calls.send).not.toHaveBeenCalled();
    expect(s.calls.log).not.toHaveBeenCalled();
    await out.settleAndAnswer();
    expect(s.calls.post).not.toHaveBeenCalled();
  });

  it("a hand-off to the executor that fails is retried, then told to the founder; it never strands silently", async () => {
    const s = setup();
    let n = 0;
    s.calls.send.mockImplementation(async () => {
      if (++n < 3) throw new Error("inngest down");
      return undefined;
    });
    const ok = await s.run();
    expect(n).toBe(3);
    expect(ok.unfulfilled).toBe(false);

    const down = setup();
    down.calls.send.mockRejectedValue(new Error("inngest down"));
    const out = await down.run();
    expect(down.calls.send).toHaveBeenCalledTimes(3);
    expect(out.handled.has(CARD)).toBe(true);
    expect(out.unfulfilled).toBe(true);
    expect(out.items[0]).toMatchObject({ section: "needs_you", action_id: CARD });
    await out.settleAndAnswer();
    expect(down.calls.post.mock.calls[0][0].body).toContain("tap Approve on the card to start it");
  });

  it("a replay whose status read fails re-sends rather than assume it ran", async () => {
    const s = setup({ approveResult: { ok: true, attempt: 2, alreadyQueued: false, stillQueued: false, replayed: true } });
    s.deps.readExec = async () => {
      throw new Error("db down");
    };
    await s.run();
    expect(s.calls.send).toHaveBeenCalledWith(CARD, 2);
  });

  it("a replayed approval whose card is still only queued re-sends the same event", async () => {
    const s = setup({ approveResult: { ok: true, attempt: 2, alreadyQueued: false, stillQueued: false, replayed: true }, exec: [{ id: CARD, exec_status: "queued", exec_result: null }] });
    await s.run();
    expect(s.calls.send).toHaveBeenCalledWith(CARD, 2);
  });

  it("the budget was raised and the approval then failed: it says the budget is now higher", async () => {
    const s = setup({ need: NEEDS(26021), noteItems: [item(CARD, "Raise Northwind Sales Search", { budget_from_usd: 25000, budget_to_usd: 26021 })], approveResult: { ok: false, code: "exec_blocked_no_retry" } });
    const out = await s.run();
    expect(out.unfulfilled).toBe(true);
    await out.settleAndAnswer();
    expect(s.calls.post.mock.calls[0][0].body).toContain("Your monthly ad budget is now $26,021.");
  });

  it("an email reply approves too, and its answer is the note email (no Slack post)", async () => {
    const s = setup({ via: "email", reply: "Yes, go ahead." });
    const out = await s.run();
    expect(s.calls.approve).toHaveBeenCalledTimes(1);
    await out.settleAndAnswer();
    expect(s.calls.post).not.toHaveBeenCalled();
  });
});

describe("what a reply must never do", () => {
  const untouched = async (s: ReturnType<typeof setup>, wanted?: Array<{ action_id: string; decision: string }>, p?: unknown) => {
    const out = await s.run(wanted, p);
    expect(s.calls.approve).not.toHaveBeenCalled();
    expect(s.calls.raise).not.toHaveBeenCalled();
    return out;
  };

  it("a reply that is not the verified owner's handles nothing, and nothing is approved in its review", async () => {
    const out = await untouched(setup({ reply: null }));
    expect(out.handled.size).toBe(0);
    expect(out.withhold(CARD)).toBe(true);
    expect(out.withhold("any-other-card")).toBe(true);
  });

  it("FAIL CLOSED: a no, a question or an unplaceable reply blocks every approve in that review; a yes blocks only the note's other cards", async () => {
    expect((await setup({ reply: "No, don't raise it" }).run()).withhold(CARD)).toBe(true);
    expect((await setup({ reply: "How are signups?" }).run()).withhold("x")).toBe(true);
    expect((await setup({ noteItems: null }).run()).withhold("x")).toBe(true);
    const yes = await setup({
      reply: "yes, raise Northwind",
      cards: { [CARD]: googleCard(), [CARD2]: metaCard() },
      noteItems: [item(CARD, "Raise Northwind Sales Search from $55 to $110/day"), item(CARD2, "Raise the Harbor Weekend ad set to $80/day")],
    }).run([{ action_id: CARD, decision: "approve" }]);
    expect(yes.withhold(CARD2)).toBe(true);
    expect(yes.withhold("a-card-not-in-the-note")).toBe(false);
    expect((await setup().run(undefined, { reason: "daily_check" })).withhold(CARD)).toBe(false);
  });

  it("a card past the note's visible rows was never shown, so a yes cannot approve it", async () => {
    const many = [{ section: "needs_you", text: "Pick where your ads show", locations: true, channel_slug: "meta_ads" }, ...Array.from({ length: 5 }, (_, k) => item(`0000000${k}-0000-4000-8000-000000000000`, `Raise campaign ${k}`))];
    const hidden = (many[5] as { action_id: string }).action_id;
    const s = setup({ reply: "yes to all", noteItems: many, cards: { [hidden]: googleCard(hidden) } });
    const out = await s.run([{ action_id: hidden, decision: "approve" }]);
    expect(s.calls.approve).not.toHaveBeenCalled();
    expect(out.handled.has(hidden)).toBe(false);
  });

  it.each([
    "Why would we do that?",
    "no",
    "wait, not yet",
    "Don't raise it",
    "I'll look into it",
    "How is this going",
    "ok but hold off for now",
    "that's ok, leave it as is",
    "sure, I'll think about it",
    "approve nothing",
    "yes but make it $80",
    "ok once the new creative is live",
    "I saw this. yes it spends everything",
  ])(
    "the model says approve but the founder wrote %j: nothing is approved",
    async (reply) => {
      const out = await untouched(setup({ reply }));
      expect(out.handled.size).toBe(0);
    },
  );

  it("the card changed since the note (its amounts are no longer the line's): a yes changes nothing", async () => {
    const changed = { ...googleCard(), exec_payload: { campaign_id: "c-1", daily_budget_usd: 400, expected_current_daily_budget_usd: 55, rationale: "", over_cap: true } };
    const noteItems = [item(CARD, "Raise Northwind Sales Search", { card_change: cardChangeSentence(googleCard().exec_class, googleCard().exec_payload) })];
    const out = await untouched(setup({ reply: "yes", cards: { [CARD]: changed }, noteItems }));
    expect(out.unfulfilled).toBe(true);
    await out.settleAndAnswer();
  });

  it("a note item with no code-written sentence (an older note, a card code cannot render) is never approved by a reply", async () => {
    const out = await untouched(setup({ reply: "yes", noteItems: [item(CARD, "Raise Northwind Sales Search from $55 to $110/day", { card_change: null })] }));
    expect(out.unfulfilled).toBe(true);
    const odd = { ...googleCard(), exec_payload: { campaign_id: "c-1" } };
    await untouched(setup({ reply: "yes", cards: { [CARD]: odd } }));
  });

  it("a yes cannot reach another card of the same chain: only the exact card on the line", async () => {
    const root = "66666666-6666-4666-8666-666666666666";
    const s = setup({ noteItems: [item(CARD, "Raise Northwind Sales Search from $55 to $110/day", { chain_root_id: root })], cards: { [CARD]: googleCard(), [root]: googleCard(root) } });
    const out = await s.run([{ action_id: root, decision: "approve" }]);
    expect(s.calls.approve.mock.calls.map((c) => c[1].actionId)).toEqual([CARD]);
    expect(out.handled.has(root)).toBe(false);
  });

  it("a yes that names a different amount than the card changes nothing and says so", async () => {
    const out = await untouched(setup({ reply: "Go ahead and raise it to $200/day" }));
    expect(out.unfulfilled).toBe(true);
    expect(out.items[0]).toMatchObject({ section: "needs_you", action_id: CARD });
  });

  it("a one-tap answer (answer:<id>) and a non-reply review approve nothing", async () => {
    await untouched(setup(), undefined, { reason: "founder_reply", founder_reply: { via: "slack", reply_run_id: "answer:q1" } });
    await untouched(setup(), undefined, { reason: "daily_check" });
  });

  it("a card that is not in the note that was replied to is not this path's", async () => {
    const s = setup({ cards: { [CARD]: googleCard(), [CARD2]: metaCard() } });
    const out = await s.run([{ action_id: CARD2, decision: "approve" }, { action_id: CARD, decision: "approve" }]);
    expect(s.calls.approve).toHaveBeenCalledTimes(1);
    expect(out.handled.has(CARD2)).toBe(false);
  });

  it("MUST CATCH (grok, PR #4128): three grouped cards and one other ad card, a bare yes approves nothing", async () => {
    const g = (n: number) => item(`00000000-0000-4000-8000-00000000009${n}`, `Raise ad set ${n}`, { channel_slug: "meta_ads", title: `Ad set ${n}` });
    const s = setup({ reply: "yes", noteItems: [item(CARD, "Raise Northwind Sales Search from $55 to $110/day"), g(1), g(2), g(3)] });
    await s.run([]);
    expect(s.calls.approve).not.toHaveBeenCalled();
    expect(s.calls.raise).not.toHaveBeenCalled();
  });

  it("MUST CATCH (grok, pre-deploy #4128): a yes withholds the grouped cards from cgo's own approval too", async () => {
    const g = (n: number) => item(`00000000-0000-4000-8000-00000000009${n}`, `Raise ad set ${n}`, { channel_slug: "meta_ads", title: `Ad set ${n}` });
    const s = setup({ reply: "yes raise Northwind", noteItems: [item(CARD, "Raise Northwind Sales Search from $55 to $110/day"), g(1), g(2), g(3)] });
    const out = await s.run();
    for (const n of [1, 2, 3]) expect(out.withhold(`00000000-0000-4000-8000-00000000009${n}`)).toBe(true);
    expect(out.withhold("a-card-not-in-the-note")).toBe(false);
  });

  it("PR2 item 4: cards folded into one \"N cards\" row are not approved by a reply, and are withheld from cgo", async () => {
    const f = (n: number) => item(`00000000-0000-4000-8000-00000000008${n}`, "Hold this ad. Meta isn't linked", { channel_slug: "meta_ads" });
    const s = setup({ reply: "yes", noteItems: [item(CARD, "Raise Northwind Sales Search from $55 to $110/day"), f(1), f(2)] });
    const out = await s.run([{ action_id: "00000000-0000-4000-8000-000000000081", decision: "approve" }]);
    expect(s.calls.approve).not.toHaveBeenCalled();
    for (const n of [1, 2]) expect(out.withhold(`00000000-0000-4000-8000-00000000008${n}`)).toBe(true);
    const named = setup({ reply: "yes raise Northwind", noteItems: [item(CARD, "Raise Northwind Sales Search from $55 to $110/day"), f(1), f(2)] });
    await named.run();
    expect(named.calls.approve).toHaveBeenCalledTimes(1);
  });

  it("three grouped cards and one other: a reply naming the other still approves it", async () => {
    const g = (n: number) => item(`00000000-0000-4000-8000-00000000009${n}`, `Raise ad set ${n}`, { channel_slug: "meta_ads", title: `Ad set ${n}` });
    const s = setup({ reply: "yes raise Northwind", noteItems: [item(CARD, "Raise Northwind Sales Search from $55 to $110/day"), g(1), g(2), g(3)] });
    await s.run();
    expect(s.calls.approve).toHaveBeenCalledTimes(1);
  });

  it("two cards and a bare yes: nothing changes and it asks which", async () => {
    const s = setup({
      reply: "yes",
      cards: { [CARD]: googleCard(), [CARD2]: metaCard() },
      noteItems: [item(CARD, "Raise Northwind Sales Search from $55 to $110/day"), item(CARD2, "Raise the Harbor Weekend ad set to $80/day")],
    });
    const out = await untouched(s, [{ action_id: CARD, decision: "approve" }, { action_id: CARD2, decision: "approve" }]);
    expect(out.unfulfilled).toBe(true);
    expect([...out.handled].sort()).toEqual([CARD, CARD2].sort());
  });

  it("one card's words never vouch for another: 'yes raise Harbor' does not approve the card that pauses Harbor", async () => {
    const pause: CardRow = { id: CARD2, run_id: null, channel_slug: "meta_ads", title: "Pause the Harbor Weekend ad set", exec_class: "meta_ads.set_status", exec_payload: { object_id: "as-1", status: "PAUSED", level: "adset" } };
    const s = setup({
      reply: "yes raise Harbor",
      cards: { [CARD]: googleCard(), [CARD2]: pause },
      noteItems: [item(CARD, "Raise Northwind Sales Search from $55 to $110/day"), item(CARD2, "Pause the Harbor Weekend ad set", { channel_slug: "meta_ads" })],
    });
    const out = await untouched(s, [{ action_id: CARD, decision: "approve" }, { action_id: CARD2, decision: "approve" }]);
    expect(out.unfulfilled).toBe(true);
  });

  it("two cards and a reply that names one approves only that one", async () => {
    const s = setup({
      reply: "yes, raise Northwind",
      cards: { [CARD]: googleCard(), [CARD2]: metaCard() },
      noteItems: [item(CARD, "Raise Northwind Sales Search from $55 to $110/day"), item(CARD2, "Raise the Harbor Weekend ad set to $80/day")],
    });
    await s.run([{ action_id: CARD, decision: "approve" }, { action_id: CARD2, decision: "approve" }]);
    expect(s.calls.approve).toHaveBeenCalledTimes(1);
    expect(s.calls.approve.mock.calls[0][1]).toMatchObject({ actionId: CARD });
  });

  it("a note that also asks a question: a bare yes may be answering that, so the card must be named", async () => {
    const noteItems = [item(CARD, "Raise Northwind Sales Search from $55 to $110/day"), { section: "needs_you", text: "Keep the signups goal?", question_ordinal: 1 }];
    await untouched(setup({ reply: "yes", noteItems }));
    const named = setup({ reply: "yes raise northwind", noteItems });
    await named.run();
    expect(named.calls.approve).toHaveBeenCalledTimes(1);
  });

  it("an ad budget that cannot be read stops it; so does a daily limit", async () => {
    const a = await untouched(setup({ need: { kind: "unreadable" } }));
    expect(a.unfulfilled).toBe(true);
    await untouched(setup({ need: { kind: "unfixable", why: "over_daily_limit" } }));
  });

  it("a budget raise that is refused stops before the approval", async () => {
    const s = setup({ need: NEEDS(26021), raiseOk: false, noteItems: [item(CARD, "Raise Northwind Sales Search", { budget_from_usd: 25000, budget_to_usd: 26021 })] });
    await s.run();
    expect(s.calls.raise).toHaveBeenCalledTimes(1);
    expect(s.calls.approve).not.toHaveBeenCalled();
  });

  it("a card that is gone, or is not an ad card cgo drives, is left to the normal path", async () => {
    const gone = await untouched(setup({ cards: { [CARD]: null } }));
    expect(gone.handled.size).toBe(0);
    const post = { ...googleCard(), channel_slug: "linkedin_organic", exec_class: "social.publish.v2" };
    const other = await untouched(setup({ cards: { [CARD]: post } }));
    expect(other.handled.size).toBe(0);
  });

  it("no note, or a legacy note without items, handles nothing", async () => {
    await untouched(setup({ noteItems: null }));
  });
});

describe("replySaysYes", () => {
  const LINE = "Raise Northwind Sales Search from $55 to $110/day";
  it("a hyphenated name is not a signed amount", () => {
    expect(replySaysYes("yes Q4-2026 retargeting", "Raise Q4-2026 Retargeting from $55 to $110/day")).toBe(true);
  });
  it.each(["yes", "Go ahead and Raise Northwind Sales Search from $55 to $110/day", "OK", "sure, do it", "Approved.", "sounds good", "LGTM", "Thanks, go ahead", "hey, yes please", "yes raise it to 110 today"])("%j is a yes", (t) =>
    expect(replySaysYes(t, LINE)).toBe(true),
  );
  it.each([
    "ok that doesn't work",
    "ok that didnt land well",
    "go ahead, make it two hundred",
    "yes, switch it to Bing",
    "sure and also delete the other campaign",
    "ok whatever",
    "yes triple it",
    "go ahead and raise Contoso",
    "yes raise it to 200usd",
    "yes 2x it",
    "ok bump it to 110k",
    "yes pause it",
    "yes set it to one",
    "yes double it",
    "ok fifty",
    "yes, <$110/day",
    "yes >= 110",
    "ok ~110",
    "yes +$55",
    "yes -$20/day",
  ])("%j has words that are not the card's: not a yes", (t) => expect(replySaysYes(t, LINE)).toBe(false));
  it.each(["", "I'll look into it", "booking numbers look fine", "no", "not now", "yes?", "why", "do not raise it", "can't approve this", "yesterday was slow", "maybe", "ｙｅｓ？", "yes 🚫", "sí", "that's ok, leave it", "sure, I'll think about it", "approve nothing", "it is ok", "the numbers look good, go ahead if you agree", "yes after Friday"])("%j is not", (t) =>
    expect(replySaysYes(t, "Raise Northwind Sales Search from $55 to $110/day")).toBe(false),
  );
});

describe("a yes word never names a change", () => {
  it("no word that opens a yes is an ad action, so it cannot vouch for one on a card whose line lacks it", () => {
    for (const verb of ["raise", "increase", "bump", "pause", "stop", "cut", "lower", "enable", "resume", "launch", "delete", "remove", "set", "change", "budget", "double"]) {
      expect(replySaysYes(`yes ${verb} it`, "Some Other Card")).toBe(false);
    }
  });
});

describe("replyPointsAt", () => {
  const a = { action_id: "a", words: "Raise Northwind Sales Search from $55 to $110/day" };
  const b = { action_id: "b", words: "Raise the Harbor Weekend ad set to $80/day" };
  it("one card needs no name; several need a word only that card has, or all/both", () => {
    expect(replyPointsAt("yes", a, [a])).toBe(true);
    expect(replyPointsAt("yes", a, [a, b])).toBe(false);
    expect(replyPointsAt("yes raise the harbor one", b, [a, b])).toBe(true);
    expect(replyPointsAt("yes raise the harbor one", a, [a, b])).toBe(false);
    expect(replyPointsAt("yes to both", a, [a, b])).toBe(true);
    expect(replyPointsAt("yes", a, [a], { mustName: true })).toBe(false);
  });
});

describe("threadAnswer", () => {
  it("says what landed, what is still applying, and what did not run", () => {
    const facts = [{ kind: "approved" as const, id: "a", text: "Applying: Raise Northwind", raised_to: null }];
    expect(threadAnswer(facts, new Map([["a", { exec_status: "executed", exec_result: null }]]))).toBe("Done: Raise Northwind.");
    expect(threadAnswer(facts, new Map())).toBe("Approved: Raise Northwind. It is applying now.");
    expect(threadAnswer(facts, new Map([["a", { exec_status: "failed", exec_result: { error: "cap_refuse: ad_budget_over_month" } }]]))).toContain("this month's ad budget is still short");
  });
});

describe("replyMatchesCard", () => {
  const cls = "google_ads.update_campaign_budget_review";
  const pay = { campaign_id: "24109304360", daily_budget_usd: 110, expected_current_daily_budget_usd: 55 };
  const line = "Raise Northwind Sales Search from $55 to $110/day";
  it("a reply's amounts must be the ones the card writes, judged on the payload, not its prose", () => {
    expect(replyMatchesCard("go ahead", line, cls, pay)).toBe(true);
    expect(replyMatchesCard("go ahead and raise it from $55 to $110/day", line, cls, pay)).toBe(true);
    expect(replyMatchesCard("go ahead, raise to 110", line, cls, pay)).toBe(true);
    expect(replyMatchesCard("go ahead and raise it to $200/day", line, cls, pay)).toBe(false);
    expect(replyMatchesCard("yes, $110k", line, cls, pay)).toBe(false);
    expect(replyMatchesCard("yes raise by 110%", line, cls, pay)).toBe(false);
    expect(replyMatchesCard("yes, $1,100", line, cls, pay)).toBe(false);
    expect(replyMatchesCard("yes raise it to 200usd", line, cls, pay)).toBe(false);
    expect(replyMatchesCard("yes raise it to 110 k", line, cls, pay)).toBe(false);
    expect(replyMatchesCard("yes raise it to $383.79", `${line}. It spent $383.79`, cls, pay)).toBe(false);
    expect(replyMatchesCard("yes 24109304360", line, cls, pay)).toBe(false);
  });
  it("a budget change has a direction: naming only the current budget, or the two reversed, is not a yes to the raise", () => {
    expect(replyMatchesCard("yes, set it to $55/day", line, cls, pay)).toBe(false);
    expect(replyMatchesCard("yes, raise it from $110 to $55/day", line, cls, pay)).toBe(false);
    expect(replyMatchesCard("yes 55 110 110", line, cls, pay)).toBe(false);
    expect(replyMatchesCard("yes, $110/day", line, cls, pay)).toBe(true);
  });
  it("the reason's evidence does not block a card; a rate or target it states must be the card's", () => {
    expect(replyMatchesCard("yes", line, cls, pay, "It spent $383.79 in 7 days against a $55 daily budget, 4 conversions at $96.01 each")).toBe(true);
    expect(replyMatchesCard("yes", "Raise Northwind Sales Search", cls, pay, "Set the daily budget to $200")).toBe(false);
    expect(replyMatchesCard("yes", "Raise Northwind Sales Search", cls, pay, "It can take $200/day")).toBe(false);
    expect(replyMatchesCard("yes", "Raise Northwind Sales Search", cls, pay, "Raising it to $110 a day doubles reach")).toBe(true);
  });
  it("the line they read is held to the card's order and direction", () => {
    expect(replyMatchesCard("yes", "Lower Northwind from $110 to $55/day", cls, pay)).toBe(false);
    expect(replyMatchesCard("yes", "Northwind from $110 to $55/day", cls, pay)).toBe(false);
    expect(replyMatchesCard("yes", "Set Northwind to $55/day", cls, pay)).toBe(false);
    const cut = { campaign_id: "c", daily_budget_usd: 10, expected_current_daily_budget_usd: 20 };
    expect(replyMatchesCard("yes", "Cut Phoenix from $20 to $10/day", cls, cut)).toBe(true);
    expect(replyMatchesCard("yes", "Cut Phoenix from $10 to $20/day", cls, cut)).toBe(false);
  });
  it("a target in the reason counts with or without the currency sign", () => {
    expect(replyMatchesCard("yes", "Raise Northwind Sales Search", cls, pay, "Set the daily budget to 200")).toBe(false);
    expect(replyMatchesCard("yes", "Raise Northwind Sales Search", cls, pay, "It can take $200 a day")).toBe(false);
    expect(replyMatchesCard("yes", "Raise Northwind Sales Search", cls, pay, "Sign-ups went from 3 to 7 in a week on a 55 daily budget")).toBe(true);
    expect(replyMatchesCard("yes", "Raise Northwind Sales Search", cls, pay, "Conversions are averaging 10/day")).toBe(true);
    expect(replyMatchesCard("yes", "Raise Northwind Sales Search", cls, pay, "Raise the budget to 200 per day")).toBe(false);
  });
  it("the line the founder read must still be what the card does", () => {
    expect(replyMatchesCard("yes", "Raise Northwind Sales Search from $55 to $110/day", cls, { ...pay, daily_budget_usd: 400 })).toBe(false);
    expect(replyMatchesCard("yes", "Raise Northwind Sales Search", cls, pay)).toBe(true);
    expect(replyMatchesCard("yes", line, cls, { campaign_id: "c" })).toBe(false);
  });
  it("a card that writes no amount is not approved by a reply, or a line, that names one", () => {
    expect(replyMatchesCard("yes", "Pause the Harbor ad set", "meta_ads.set_status", {})).toBe(true);
    expect(replyMatchesCard("yes pause it and set $50", "Pause the Harbor ad set", "meta_ads.set_status", {})).toBe(false);
    expect(replyMatchesCard("yes", "Pause the $50/day Harbor ad set", "meta_ads.set_status", { object_id: "1", status: "PAUSED" })).toBe(false);
  });
  it("any other ad card is held to the money in its own body: the line read must not understate it", () => {
    const create = { campaign_id: "1", ad_set: { name: "Harbor", daily_budget_usd: 500 } };
    expect(replyMatchesCard("yes", "Start a Harbor ad set at $500/day", "meta_ads.create_ad_set", create)).toBe(true);
    expect(replyMatchesCard("yes", "Start a Harbor ad set at $50/day", "meta_ads.create_ad_set", create)).toBe(false);
    expect(replyMatchesCard("yes at 50", "Start a Harbor ad set", "meta_ads.create_ad_set", create)).toBe(false);
    expect(replyMatchesCard("yes at 500", "Start a Harbor ad set at $500/day", "meta_ads.create_ad_set", create)).toBe(false);
    expect(replyMatchesCard("yes 2", "Start a Harbor ad set", "meta_ads.create_ad_set", { ...create, bid_usd: 2 })).toBe(false);
  });
  it("reads amounts as written", () => {
    expect(amountsIn("from $55 to $110/day, 1,100 and 110k, 2.5m, 30%")).toEqual(["55", "110", "1100", "110k", "2.5m", "30%"]);
    expect(amountsIn("200usd 300dollars 2x 110 k 5 million 40 percent 7 today 110 % 3 times")).toEqual(["200usd", "300dollars", "2x", "110k", "5million", "40percent", "7", "110%", "3times"]);
  });
});

describe("a reply when no review can run (no active goal)", () => {
  it("one card and a plain yes is honored directly, through the same checks, and the thread hears what happened", async () => {
    const s = setup({ reply: "yes" });
    await applyFounderReplyWithoutReview(T, REPLY_RUN, s.deps);
    expect(s.calls.approve).toHaveBeenCalledWith(T, { actionId: CARD, eventKey: `cgo-reply:${REPLY_RUN}:${CARD}`, actorUserId: OWNER });
    expect(s.calls.post.mock.calls[0][0].body).toBe("Done: Raise Northwind Sales Search from $55 to $110/day.");
  });

  it("does strictly less than a review: with two cards nothing is approved even when the reply names one, and the thread is told", async () => {
    const two = { cards: { [CARD]: googleCard(), [CARD2]: metaCard() }, noteItems: [item(CARD, "Raise Northwind Sales Search from $55 to $110/day"), item(CARD2, "Raise the Harbor Weekend ad set to $80/day")] };
    for (const reply of ["yes raise Northwind", "yes to both", "yes"]) {
      const s = setup({ ...two, reply });
      await applyFounderReplyWithoutReview(T, REPLY_RUN, s.deps);
      expect(s.calls.approve).not.toHaveBeenCalled();
      expect(s.calls.raise).not.toHaveBeenCalled();
      expect(s.calls.post.mock.calls[0][0].body).toContain("I did not change anything from your reply");
    }
  });

  it("a no, or a reply that cannot be verified, approves nothing", async () => {
    for (const reply of ["no", null]) {
      const s = setup({ reply });
      await applyFounderReplyWithoutReview(T, REPLY_RUN, s.deps);
      expect(s.calls.approve).not.toHaveBeenCalled();
    }
  });
});

describe("cardChangeSentence", () => {
  it("is the card page's own sentence, from the body the executor parses, for Google and Meta", () => {
    expect(cardChangeSentence(googleCard().exec_class, { ...(googleCard().exec_payload as object), name: "Northwind Sales Search", verified_name: "Northwind Sales Search" })).toBe(
      "Zavi changes the daily budget of “Northwind Sales Search” from $55 to $110, adding about $1,672 a month at full delivery.",
    );
    expect(cardChangeSentence(metaCard().exec_class, metaCard().exec_payload)).toMatch(/\$40.*\$80/);
    expect(cardChangeSentence("google_ads.update_campaign_budget", { campaign_id: "c" })).toBeNull();
    expect(cardChangeSentence("social.publish.v2", {})).toBeNull();
    expect(cardChangeSentence(null, {})).toBeNull();
    expect(cardChangeSentence("google_ads.update_ad_group", { ad_group_id: "1", cpc_bid_usd: 50 })).toBeNull();
    expect(cardChangeSentence("google_ads.update_campaign", { campaign_id: "1", target_cpa_usd: 40 })).toBeNull();
    expect(cardChangeSentence("meta_ads.create_ad_set", { campaign_id: "1" })).toBeNull();
  });
});
