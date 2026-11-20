import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
const rpcCalls: Array<{ fn: string; args: Row }> = [];
let pauseOutcome = "ok";

class Query {
  private filters: Array<(r: Row) => boolean> = [];
  private op: "select" | "update" | "insert" = "select";
  private patch: Row = {};
  private max = Infinity;
  constructor(private table: string) {}
  select() {
    return this;
  }
  update(p: Row) {
    this.op = "update";
    this.patch = p;
    return this;
  }
  insert(r: Row) {
    this.op = "insert";
    this.patch = r;
    return this;
  }
  eq(c: string, v: unknown) {
    this.filters.push((r) => r[c] === v);
    return this;
  }
  neq(c: string, v: unknown) {
    this.filters.push((r) => r[c] != null && r[c] !== v);
    return this;
  }
  or(expr: string) {
    if (expr !== "on_yes.is.null,on_yes->>kind.neq.hypothesis_check") throw new Error(`fake db: unexpected or(${expr})`);
    this.filters.push((r) => r.on_yes == null || (r.on_yes as { kind?: string }).kind !== "hypothesis_check");
    return this;
  }
  in(c: string, vs: unknown[]) {
    this.filters.push((r) => vs.includes(r[c]));
    return this;
  }
  like(c: string, pattern: string) {
    const prefix = pattern.replace(/%$/, "");
    this.filters.push((r) => String(r[c] ?? "").startsWith(prefix));
    return this;
  }
  lte(c: string, v: string) {
    this.filters.push((r) => r[c] != null && String(r[c]) <= v);
    return this;
  }
  gte(c: string, v: string) {
    this.filters.push((r) => String(r[c] ?? "") >= v);
    return this;
  }
  order() {
    return this;
  }
  limit(n: number) {
    this.max = n;
    return this;
  }
  then<T>(ok: (v: { data: unknown; error: unknown }) => T) {
    const rows = db[this.table] ?? [];
    if (this.op === "insert") {
      const waiting = (st: unknown) => st === "open" || st === "queued";
      if (rows.some((r) => r.tenant_id === this.patch.tenant_id && r.topic_key === this.patch.topic_key && waiting(r.status) && waiting(this.patch.status))) {
        return Promise.resolve({ data: null, error: { code: "23505", message: "duplicate key" } }).then(ok);
      }
      rows.push({ id: `q${rows.length + 1}`, ...this.patch });
      db[this.table] = rows;
      return Promise.resolve({ data: null, error: null }).then(ok);
    }
    const hit = rows.filter((r) => this.filters.every((f) => f(r))).slice(0, this.max);
    if (this.op === "update") for (const r of hit) Object.assign(r, this.patch);
    return Promise.resolve({ data: hit, error: null }).then(ok);
  }
}

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({ from: (t: string) => new Query(t) }),
  tenantRpc: async (_t: string, fn: string, args: Row) => {
    rpcCalls.push({ fn, args });
    return { data: fn === "pause_channel_by_cgo" ? pauseOutcome : 0, error: null };
  },
}));

import { ASK_MAX, COUNT_ASK_MAX, MAX_QUEUED_QUESTIONS, WHY_MAX, clipAsk, insertQuestions, markAnswered, markFounderReplied, planQuestions, planQuestionsDetailed, promoteQueued, sweepExpiredQuestions, withdrawStaleGoalQuestions, topicGoalId, defaultLine, hypothesisAsk, isYesNoAsk, withdrawStaleHypothesisQuestions } from "../cgo-questions";
import { clipAtWord, normalizeAsk } from "../question-text";

const T = "t-1";
const OTHER = "t-2";
const NOW = new Date("2026-09-27T14:00:00Z");
const past = "2026-09-26T00:00:00.000Z";
const future = "2026-09-30T00:00:00.000Z";

beforeEach(() => {
  for (const k of Object.keys(db)) delete db[k];
  db.cgo_questions = [];
  db.cgo_notes = [{ id: "n1", tenant_id: T, run_id: "run-1" }];
  db.channel_action_events = [];
  db.channel_actions = [];
  rpcCalls.length = 0;
  pauseOutcome = "ok";
});

describe("planQuestions", () => {
  it("a count question keeps its whole definition up to COUNT_ASK_MAX; others clip at ASK_MAX", () => {
    const long = `I'll count "renters" as ${"a ".repeat(250).trim()}. Today that is 19. Use this?`;
    expect(long.length).toBeGreaterThan(ASK_MAX);
    const out = planQuestions(
      [
        { topic_key: "count-1", ask: long, default_action: null, count_rule: { dialect: "sql" } },
        { topic_key: "plain", ask: long, default_action: null },
      ],
      [],
      NOW,
    );
    expect(out[0].ask).toBe(long);
    expect(out[0].ask.length).toBeLessThanOrEqual(COUNT_ASK_MAX);
    expect(out[1].ask.length).toBeLessThanOrEqual(ASK_MAX);
  });

  it("drops open and queued topics, topics answered in the last 14 days, and duplicates; only a pause default gets a deadline, clamped to 2-7 days", () => {
    const pause = (slug: string) => ({ kind: "pause_channel" as const, channel_slug: slug, why: "w" });
    const out = planQuestions(
      [
        { topic_key: "Reddit budget", ask: "a?", default_action: pause("reddit_organic") },
        { topic_key: "seo", ask: "b?", default_action: null, days: 30 },
        { topic_key: "reddit-budget", ask: "dup?", default_action: null },
        { topic_key: "old", ask: "c?", default_action: null },
        { topic_key: "waiting", ask: "w?", default_action: null },
        { topic_key: "fresh", ask: "d?", default_action: pause("seo"), days: 0 },
      ],
      [
        { topic_key: "old", status: "answered", asked_at: "2026-09-01T00:00:00Z", answered_at: "2026-09-20T00:00:00Z", expires_at: null },
        { topic_key: "waiting", status: "queued", asked_at: past, answered_at: null, expires_at: null },
      ],
      NOW,
    );
    expect(out.map((q) => [q.topic_key, q.expires_at, q.queued ?? false, q.default_action?.kind ?? null])).toEqual([
      ["reddit-budget", "2026-09-30T14:00:00.000Z", false, "pause_channel"],
      ["seo", null, false, null],
      ["fresh", null, true, null],
    ]);
  });

  it("at most two open at once: the rest queue, up to the queue limit; past it they are overflow", () => {
    const open = (topic_key: string) => ({ topic_key, status: "open" as const, asked_at: past, answered_at: null, expires_at: null });
    const queued = (topic_key: string) => ({ topic_key, status: "queued" as const, asked_at: past, answered_at: null, expires_at: null });
    const asks = [
      { topic_key: "a", ask: "a?", default_action: null },
      { topic_key: "b", ask: "b?", default_action: null },
    ];
    expect(planQuestions(asks, [open("x")], NOW).map((q) => [q.topic_key, q.queued ?? false])).toEqual([
      ["a", false],
      ["b", true],
    ]);
    expect(planQuestions(asks, [open("x"), open("y")], NOW).map((q) => [q.topic_key, q.queued ?? false])).toEqual([
      ["a", true],
      ["b", true],
    ]);
    const full = Array.from({ length: MAX_QUEUED_QUESTIONS - 1 }, (_, i) => queued(`q${i}`));
    const r = planQuestionsDetailed(asks, [open("x"), open("y"), ...full], NOW);
    expect(r.planned.map((q) => q.topic_key)).toEqual(["a"]);
    expect(r.overflow).toEqual(["b?"]);
  });

  it("a withdrawn or expired question does not hold its topic: cgo may ask again at once, and it takes no open slot", () => {
    const row = (status: "withdrawn" | "expired") => ({ topic_key: "goal:g1", status, asked_at: past, answered_at: null, expires_at: past });
    const ask = [{ topic_key: "goal:g1", ask: "Should I raise it?", default_action: null }];
    expect(planQuestions(ask, [row("withdrawn")], NOW).map((q) => q.topic_key)).toEqual(["goal:g1"]);
    expect(planQuestions(ask, [row("expired")], NOW).map((q) => q.topic_key)).toEqual(["goal:g1"]);
  });

  it("a required (server-raised) question opens even with two open; cgo's own queues", () => {
    const open = (topic_key: string) => ({ topic_key, status: "open" as const, asked_at: past, answered_at: null, expires_at: null });
    const out = planQuestions(
      [
        { required: true, topic_key: "goal:g1", ask: "Raise it?", default_action: null },
        { topic_key: "extra", ask: "Anything else?", default_action: null },
      ],
      [open("x"), open("y")],
      NOW,
    );
    expect(out.map((q) => [q.topic_key, q.queued ?? false])).toEqual([
      ["goal:g1", false],
      ["extra", true],
    ]);
  });

  it("a topic closed more than 14 days ago can be asked again", () => {
    const out = planQuestions(
      [{ topic_key: "old", ask: "c?", default_action: null }],
      [{ topic_key: "old", status: "answered", asked_at: "2026-09-01T00:00:00Z", answered_at: "2026-09-04T00:00:00Z", expires_at: null }],
      NOW,
    );
    expect(out).toHaveLength(1);
  });

  it("splits a long ask: the closing question is the ask, the context before it the why", () => {
    const [q] = planQuestions(
      [{ topic_key: "cpa", ask: "Your CPA was $41 last week, up from $22. Most of it went to one ad set. Should I cut that ad set's budget in half?", default_action: null }],
      [],
      NOW,
    );
    expect(q.ask).toBe("Should I cut that ad set's budget in half?");
    expect(q.why).toBe("Your CPA was $41 last week, up from $22. Most of it went to one ad set.");
  });

  it("keeps cgo's own why when it gave one; the context is not stacked on top", () => {
    const [q] = planQuestions(
      [{ topic_key: "cpa", ask: "CPA doubled. Should I cut it?", why: "It costs twice what it did.", default_action: null }],
      [],
      NOW,
    );
    expect(q).toMatchObject({ ask: "Should I cut it?", why: "It costs twice what it did." });
  });

  it("an ask with no question in it is not asked; a question mid-text is kept whole", () => {
    const out = planQuestions(
      [
        { topic_key: "statement", ask: "Your CPA is $41. I lowered the bid.", default_action: null },
        { topic_key: "mid", ask: "Grow signups shows 12. What is it today? Update it on the goal.", default_action: null },
      ],
      [],
      NOW,
    );
    expect(out.map((q) => [q.topic_key, q.ask])).toEqual([["mid", "Grow signups shows 12. What is it today? Update it on the goal."]]);
  });

  it("server asks (required) and count questions keep their words, with or without a question", () => {
    const count = `I'll count "renters" as people with a trip. Today that is 19. Use this?`;
    const out = planQuestions(
      [
        { required: true, topic_key: "channel:reddit_organic", ask: "Reddit: no approvals. You added it, so I left it running. Pause it if you agree.", default_action: null },
        { topic_key: "count-1", ask: count, default_action: null, count_rule: { dialect: "sql" } },
      ],
      [],
      NOW,
    );
    expect(out.map((q) => q.ask)).toEqual(["Reddit: no approvals. You added it, so I left it running. Pause it if you agree.", count]);
    expect(out.every((q) => q.why === undefined)).toBe(true);
  });

  it("the default line names the channel and the date", () => {
    expect(defaultLine({ kind: "pause_channel", channel_slug: "reddit_organic", why: "x" }, "2026-10-03T12:00:00Z")).toBe(
      "If I don't hear back by Oct 3, I'll pause Reddit.",
    );
    expect(defaultLine(null, future)).toBeNull();
  });
});

describe("insertQuestions", () => {
  it("a topic a concurrent review already opened is 'already asked', not an error", async () => {
    db.cgo_questions.push({ id: "q0", tenant_id: T, topic_key: "seo", status: "open" });
    const stored = await insertQuestions(T, "run-1", [
      { topic_key: "seo", ask: "b", default_action: null, expires_at: future },
      { topic_key: "reddit", ask: "a", default_action: null, expires_at: future },
    ]);
    expect(stored.map((q) => q.topic_key)).toEqual(["reddit"]);
    expect(db.cgo_questions.filter((q) => q.topic_key === "seo")).toHaveLength(1);
  });
});

describe("markAnswered", () => {
  it("only this tenant's open questions, once each", async () => {
    db.cgo_questions.push(
      { id: "a", tenant_id: T, status: "open" },
      { id: "b", tenant_id: OTHER, status: "open" },
      { id: "c", tenant_id: T, status: "expired" },
    );
    const n = await markAnswered(
      T,
      [
        { question_id: "a", answer: "Keep it." },
        { question_id: "a", answer: "again" },
        { question_id: "b", answer: "x" },
        { question_id: "c", answer: "x" },
      ],
      "email",
      "run-r",
      NOW,
    );
    expect(n).toBe(1);
    expect(db.cgo_questions.map((q) => q.status)).toEqual(["answered", "open", "expired"]);
    expect(db.cgo_questions[0]).toMatchObject({ answer: "Keep it.", answered_via: "email", resolved_run_id: "run-r" });
  });

  it("never closes a hypothesis question (only answer_hypothesis_question does, with the founder's own words)", async () => {
    db.cgo_questions.push({ id: "h", tenant_id: T, status: "open", on_yes: { kind: "hypothesis_check", hypothesis_id: "x", goal_id: "g", claim: "c" } });
    const n = await markAnswered(T, [{ question_id: "h", answer: "they said yes" }], "email", "run-r", NOW);
    expect(n).toBe(0);
    expect(db.cgo_questions[0].status).toBe("open");
  });
});

describe("sweepExpiredQuestions", () => {
  const pauseQ = (over: Row = {}): Row => ({
    id: "q1",
    tenant_id: T,
    topic_key: "reddit",
    ask: "Keep Reddit?",
    status: "open",
    asked_run_id: "run-1",
    asked_at: past,
    expires_at: past,
    default_action: { kind: "pause_channel", channel_slug: "reddit_organic", why: "No clicks in 14 days." },
    ...over,
  });

  it("Autopilot on: expires it, pauses through the RPC under the run that asked, closes its cards, and says so", async () => {
    db.cgo_questions.push(pauseQ());
    const out = await sweepExpiredQuestions(T, NOW, { autopilot: true });
    expect(out).toEqual({ expired: 1, applied: ['No answer on "Keep Reddit?", so I paused Reddit as I said I would.'] });
    expect(rpcCalls).toEqual([
      { fn: "pause_channel_by_cgo", args: { p_tenant_id: T, p_channel_slug: "reddit_organic", p_reason: "No clicks in 14 days.", p_run_id: "run-1" } },
      { fn: "close_channel_actions_on_cgo_pause", args: { p_tenant_id: T, p_channel_slug: "reddit_organic", p_run_id: "run-1", p_why: "No clicks in 14 days." } },
    ]);
    expect(db.cgo_questions[0]).toMatchObject({ status: "expired", default_applied: true });
  });

  it("R6: a default whose note never reached the founder does not pause", async () => {
    db.cgo_notes = [];
    db.cgo_questions.push(pauseQ());
    const out = await sweepExpiredQuestions(T, NOW, { autopilot: true });
    expect(out.applied).toEqual([]);
    expect(rpcCalls).toHaveLength(0);
  });

  it("R6: the founder rejected one of the channel's cards after the ask: not silence, no pause", async () => {
    db.channel_actions = [{ id: "c1", tenant_id: T, channel_slug: "reddit_organic" }];
    db.channel_action_events = [{ tenant_id: T, action_id: "c1", actor_kind: "founder", event: "rejected", at: "2026-09-26T12:00:00.000Z" }];
    db.cgo_questions.push(pauseQ());
    const out = await sweepExpiredQuestions(T, NOW, { autopilot: true });
    expect(out.applied).toEqual([]);
    expect(rpcCalls).toHaveLength(0);
  });

  it("R6/R1: an ad channel's pause default (stored before S1) never pauses it on silence", async () => {
    db.cgo_questions.push(pauseQ({ default_action: { kind: "pause_channel", channel_slug: "meta_ads", why: "x" } }));
    const out = await sweepExpiredQuestions(T, NOW, { autopilot: true });
    expect(out).toEqual({ expired: 1, applied: [] });
    expect(rpcCalls).toHaveLength(0);
  });

  it("Autopilot off: it only expires. Nothing is paused and nothing is said", async () => {
    db.cgo_questions.push(pauseQ());
    const out = await sweepExpiredQuestions(T, NOW, { autopilot: false });
    expect(out).toEqual({ expired: 1, applied: [] });
    expect(rpcCalls).toHaveLength(0);
    expect(db.cgo_questions[0].default_applied).toBeUndefined();
  });

  it("the founder replied after it was asked: it closes without acting, whatever the reply was about", async () => {
    db.cgo_questions.push(pauseQ(), pauseQ({ id: "q-other", tenant_id: OTHER }));
    await markFounderReplied(T, NOW);
    expect(db.cgo_questions.map((q) => q.founder_replied_at ?? null)).toEqual([NOW.toISOString(), null]);
    const out = await sweepExpiredQuestions(T, NOW, { autopilot: true });
    expect(out).toEqual({ expired: 1, applied: [] });
    expect(rpcCalls).toHaveLength(0);
  });

  it("Autopilot switched off after the sweep started: the live re-read stops the default", async () => {
    db.cgo_questions.push(pauseQ());
    const out = await sweepExpiredQuestions(T, NOW, { autopilot: true, autopilotNow: async () => false });
    expect(out).toEqual({ expired: 1, applied: [] });
    expect(rpcCalls).toHaveLength(0);
  });

  it("a channel the founder added is refused by the RPC: no close, no line", async () => {
    pauseOutcome = "founder_owned";
    db.cgo_questions.push(pauseQ());
    const out = await sweepExpiredQuestions(T, NOW, { autopilot: true });
    expect(out.applied).toEqual([]);
    expect(rpcCalls.map((c) => c.fn)).toEqual(["pause_channel_by_cgo"]);
  });

  it("never touches a question not yet due, one already closed, or another tenant's", async () => {
    db.cgo_questions.push(pauseQ({ id: "q-future", expires_at: future }), pauseQ({ id: "q-done", status: "answered" }), pauseQ({ id: "q-other", tenant_id: OTHER }));
    const out = await sweepExpiredQuestions(T, NOW, { autopilot: true });
    expect(out).toEqual({ expired: 0, applied: [] });
    expect(db.cgo_questions.map((q) => q.status)).toEqual(["open", "answered", "open"]);
  });

  it("an unknown channel, or no asking run, applies nothing", async () => {
    db.cgo_questions.push(
      pauseQ({ id: "a", default_action: { kind: "pause_channel", channel_slug: "the_moon", why: "x" } }),
      pauseQ({ id: "b", topic_key: "b", asked_run_id: null }),
    );
    const out = await sweepExpiredQuestions(T, NOW, { autopilot: true });
    expect(out).toEqual({ expired: 2, applied: [] });
    expect(rpcCalls).toHaveLength(0);
  });

  it("a goal default is never applied on silence: the question just closes", async () => {
    const change = { kind: "goal_change", goal_id: "g1", goal_rev: "rev1", change: { target_value: 30 }, why: "Ahead." };
    db.cgo_questions.push(pauseQ({ default_action: change }));
    const out = await sweepExpiredQuestions(T, NOW, { autopilot: true });
    expect(out).toEqual({ expired: 1, applied: [] });
    expect(rpcCalls).toHaveLength(0);
  });
});

describe("question-text", () => {
  it("clipAtWord never cuts mid-word: long context, long question, one unbroken token", () => {
    const context = clipAtWord("Paid first trips were 15, 9, 10 and 14 a week. ".repeat(10), WHY_MAX);
    expect(context.length).toBeLessThanOrEqual(WHY_MAX);
    expect(context).toMatch(/(?:^|\s)\S+…$/);
    expect(context.replace(/…$/, "").split(" ").every((w) => "Paid first trips were 15, 9, 10 and 14 a week.".split(" ").includes(w))).toBe(true);
    const question = clipAtWord(`Should I ${"really ".repeat(80)}do it?`, 100);
    expect(question.length).toBeLessThanOrEqual(100);
    expect(question.endsWith("really…?")).toBe(true);
    const token = clipAtWord("x".repeat(500), 50);
    expect(token).toBe(`${"x".repeat(49)}…`);
  });

  it("normalizeAsk splits a long question sentence and fits it to ASK_MAX", () => {
    const long = `Context first. Should I ${"really ".repeat(80)}do it?`;
    const n = normalizeAsk(long, null);
    expect(n?.why).toBe("Context first.");
    expect(n!.ask.length).toBeLessThanOrEqual(ASK_MAX);
    expect(n!.ask.startsWith("Should I really")).toBe(true);
    expect(n!.ask.endsWith("?")).toBe(true);
  });

  it("normalizeAsk keeps two closing questions together and rejects empty or question-less asks", () => {
    expect(normalizeAsk("CPA doubled. Should I raise it? Or keep 150?", "")).toEqual({ ask: "Should I raise it? Or keep 150?", why: "CPA doubled." });
    expect(normalizeAsk("   ", "")).toBeNull();
    expect(normalizeAsk("I paused Reddit.", "")).toBeNull();
    expect(normalizeAsk("I paused Reddit.", "", { required: true })).toEqual({ ask: "I paused Reddit.", why: "" });
  });
});

describe("clipAsk", () => {
  it("leaves an ask under the limit alone", () => {
    expect(clipAsk("  Should I pause Reddit?  ")).toBe("Should I pause Reddit?");
  });

  it("keeps the closing question when the evidence runs long", () => {
    const evidence = "Paid first trips were 15, 9, 10, 14, 20, 5, 22 and 16 in the eight weeks from Aug 3. ".repeat(6);
    const question = "Should I set the target to 24 a week instead?";
    const out = clipAsk(evidence + question);
    expect(out.length).toBeLessThanOrEqual(ASK_MAX);
    expect(out.endsWith(question)).toBe(true);
    expect(out).toContain("… ");
    expect(out.startsWith("Paid first trips were 15")).toBe(true);
  });

  it("cuts one long sentence at a word, with an ellipsis", () => {
    const out = clipAsk("word ".repeat(200));
    expect(out.length).toBeLessThanOrEqual(ASK_MAX);
    expect(out.endsWith("word…")).toBe(true);
  });
});

describe("a hypothesis question (owner call C)", () => {
  const h = { id: "h-1", goal_id: "g-1", claim: "Hosts cancel paid bookings. Renters then leave? Mostly on weekends." };

  it("is one yes/no sentence carrying the whole claim, never cut, with no default on silence", () => {
    const a = hypothesisAsk(h, "Only your own records can settle this.");
    expect(a.ask).toBe("Is this true for your business: Hosts cancel paid bookings; Renters then leave; Mostly on weekends?");
    expect(isYesNoAsk(a.ask)).toBe(true);
    expect(hypothesisAsk({ ...h, claim: "Hosts cancel\nRenters leave." }, "w").ask).toBe("Is this true for your business: Hosts cancel; Renters leave?");
    expect(a).toMatchObject({ required: true, topic_key: "hyp:h-1", default_action: null, on_yes: { kind: "hypothesis_check", hypothesis_id: "h-1", goal_id: "g-1", claim: h.claim } });
    const long = hypothesisAsk({ ...h, claim: "x".repeat(10) + " word".repeat(78) }, "w");
    const [planned] = planQuestions([long], [], NOW);
    expect(planned.ask).toBe(long.ask);
    expect(planned.ask.length).toBeGreaterThan(ASK_MAX);
  });

  it("one open at a time, tenant-wide, even though it is required", () => {
    const a1 = hypothesisAsk(h, "w");
    const a2 = hypothesisAsk({ ...h, id: "h-2" }, "w");
    expect(planQuestions([a1, a2], [], NOW).map((q) => q.topic_key)).toEqual(["hyp:h-1"]);
    const open = [{ topic_key: "hyp:h-9", status: "open" as const, asked_at: past, answered_at: null, expires_at: future }];
    expect(planQuestions([a2], open, NOW)).toEqual([]);
    expect(planQuestions([{ topic_key: "hyp:hosts", ask: "Should I check hosts?", default_action: null }], [], NOW)).toEqual([]);
    expect(planQuestions([{ required: true, topic_key: "goal:x", ask: "Should I lower it?", default_action: null }], open, NOW)).toHaveLength(1);
  });

  it("withdraws an open one whose hypothesis closed, was re-worded or is gone; keeps a live one, and a paused goal's", async () => {
    const on = (id: string, claim = "c") => ({ kind: "hypothesis_check", hypothesis_id: id, goal_id: "g", claim });
    db.cgo_questions.push(
      { id: "q1", tenant_id: T, status: "open", topic_key: "hyp:a", on_yes: on("a") },
      { id: "q2", tenant_id: T, status: "open", topic_key: "hyp:b", on_yes: on("b") },
      { id: "q3", tenant_id: T, status: "open", topic_key: "hyp:c", on_yes: on("c") },
      { id: "q4", tenant_id: T, status: "open", topic_key: "hyp:d", on_yes: on("d") },
      { id: "q5", tenant_id: OTHER, status: "open", topic_key: "hyp:e", on_yes: on("e") },
      { id: "q6", tenant_id: T, status: "open", topic_key: "hyp:p", on_yes: on("p") },
    );
    db.cgo_hypotheses = [{ id: "p", tenant_id: T }];
    const n = await withdrawStaleHypothesisQuestions(T, [
      { id: "a", status: "testing", claim: "c" },
      { id: "b", status: "confirmed", claim: "c" },
      { id: "c", status: "listed", claim: "re-worded" },
    ]);
    expect(n).toBe(3);
    expect(db.cgo_questions.map((q) => q.status)).toEqual(["open", "withdrawn", "withdrawn", "withdrawn", "open", "open"]);
  });
});

describe("the queue (questions stay open until answered)", () => {
  it("a queued ask is stored with no number, no deadline and no default", async () => {
    const stored = await insertQuestions(T, "run-1", [
      { topic_key: "a", ask: "A?", default_action: null, expires_at: null },
      { topic_key: "b", ask: "B?", default_action: null, expires_at: null, queued: true },
    ]);
    expect(stored.map((q) => q.ordinal)).toEqual([1, null]);
    expect(db.cgo_questions.map((r) => [r.topic_key, r.status, r.ordinal, r.expires_at, r.default_action])).toEqual([
      ["a", "open", 1, null, null],
      ["b", "queued", null, null, null],
    ]);
  });

  it("promoteQueued opens the oldest queued while there is room, numbered, asked from now", async () => {
    db.cgo_questions = [
      { id: "o1", tenant_id: T, topic_key: "x", status: "open", ordinal: 1, asked_at: past },
      { id: "w1", tenant_id: T, topic_key: "a", status: "queued", ordinal: null, asked_at: past, expires_at: null },
      { id: "w2", tenant_id: T, topic_key: "b", status: "queued", ordinal: null, asked_at: past, expires_at: null },
      { id: "z1", tenant_id: OTHER, topic_key: "c", status: "queued", ordinal: null, asked_at: past, expires_at: null },
    ];
    expect(await promoteQueued(T, NOW)).toBe(1);
    const byId = Object.fromEntries(db.cgo_questions.map((r) => [r.id, r]));
    expect([byId.w1.status, byId.w1.ordinal, byId.w1.asked_at]).toEqual(["open", 2, NOW.toISOString()]);
    expect(byId.w2.status).toBe("queued");
    expect(byId.z1.status).toBe("queued");
    expect(await promoteQueued(T, NOW)).toBe(0);
  });

  it("a queued ad plan whose start day passed is withdrawn, not opened; the next queued opens (PR2 item 6)", async () => {
    const plan = (start: string, end: string) => ({ kind: "ad_plan", goal_id: "g1", goal_rev: "r1", plan: { channel_slug: "meta_ads", budget_type: "daily", total_usd: 40, daily_usd: 10, start, end, days: 4, switched_from: null } });
    db.cgo_questions = [
      { id: "o1", tenant_id: T, topic_key: "x", status: "open", ordinal: 1, asked_at: past },
      { id: "stale", tenant_id: T, topic_key: "ad:1", status: "queued", ordinal: null, asked_at: "2026-10-15T00:00:00Z", expires_at: null, on_yes: plan("2026-10-16", "2026-10-20") },
      { id: "next", tenant_id: T, topic_key: "b", status: "queued", ordinal: null, asked_at: "2026-10-16T00:00:00Z", expires_at: null },
      { id: "later", tenant_id: T, topic_key: "c", status: "queued", ordinal: null, asked_at: "2026-10-17T00:00:00Z", expires_at: null, on_yes: plan("2026-10-22", "2026-10-26") },
    ];
    const oct21 = new Date("2026-10-21T14:00:00Z");
    expect(await promoteQueued(T, oct21)).toBe(1);
    const byId = Object.fromEntries(db.cgo_questions.map((r) => [r.id, r]));
    expect(byId.stale.status).toBe("withdrawn");
    expect([byId.next.status, byId.next.ordinal]).toEqual(["open", 2]);
    expect(byId.later.status).toBe("queued");
  });

  it("two promotions at once never open more than the room (the second stops at the first row it lost)", async () => {
    db.cgo_questions = Array.from({ length: 5 }, (_, k) => ({ id: `q${k}`, tenant_id: T, topic_key: `t${k}`, status: "queued", ordinal: null, asked_at: `2026-10-1${k}T00:00:00Z`, expires_at: null }));
    await Promise.all([promoteQueued(T, NOW), promoteQueued(T, NOW)]);
    expect(db.cgo_questions.filter((r) => r.status === "open").length).toBeLessThanOrEqual(2);
  });

  it("a queued ad plan starting today still opens", async () => {
    db.cgo_questions = [
      { id: "today", tenant_id: T, topic_key: "ad:2", status: "queued", ordinal: null, asked_at: past, expires_at: null, on_yes: { kind: "ad_plan", goal_id: "g1", goal_rev: "r1", plan: { start: "2026-10-21", end: "2026-10-25" } } },
    ];
    expect(await promoteQueued(T, new Date("2026-10-21T23:00:00Z"))).toBe(1);
    expect(db.cgo_questions[0].status).toBe("open");
  });

  it("the sweep never closes a question with no deadline", async () => {
    db.cgo_questions = [{ id: "o1", tenant_id: T, topic_key: "x", status: "open", asked_at: "2026-08-01T00:00:00Z", expires_at: null, default_action: null }];
    const out = await sweepExpiredQuestions(T, NOW, { autopilot: true });
    expect(out.expired).toBe(0);
    expect(db.cgo_questions[0].status).toBe("open");
  });
});

describe("withdrawStaleGoalQuestions: a question about a goal that moved on never holds a slot forever", () => {
  it("withdraws an edited goal's change, and every open or queued question about a goal no longer active; leaves the rest", async () => {
    const row = (id: string, topic_key: string, status: string, on_yes: unknown = null) => ({ id, tenant_id: T, topic_key, status, on_yes });
    db.cgo_questions = [
      row("edited", "goal:g1", "open", { kind: "goal_change", goal_id: "g1", goal_rev: "old" }),
      row("current", "goal:g1", "queued", { kind: "goal_change", goal_id: "g1", goal_rev: "r1" }),
      row("paused-basis", "basis:g2", "open", { kind: "goal_basis", goal_id: "g2", goal_rev: "r2" }),
      row("paused-count", "count:g2:abc", "queued"),
      row("paused-number", "number:g2", "open"),
      row("live-count", "count-stale:g1", "open"),
      row("channel", "channel:reddit_organic", "open"),
      row("hyp", "hyp:h1", "open", { kind: "hypothesis_check", hypothesis_id: "h1", goal_id: "g2", claim: "c" }),
      { ...row("other-tenant", "number:g2", "open"), tenant_id: OTHER },
    ];
    expect(await withdrawStaleGoalQuestions(T, new Map([["g1", "r1"]]))).toBe(4);
    const status = Object.fromEntries(db.cgo_questions.map((r) => [r.id, r.status]));
    expect(status).toEqual({
      edited: "withdrawn",
      current: "queued",
      "paused-basis": "withdrawn",
      "paused-count": "withdrawn",
      "paused-number": "withdrawn",
      "live-count": "open",
      channel: "open",
      hyp: "open",
      "other-tenant": "open",
    });
  });

  it("reads the goal from each goal topic shape", () => {
    expect(["goal:a", "basis:a", "number:a", "count-stale:a", "count:a:rule", "channel:x", "ad_budget", "action:a"].map(topicGoalId)).toEqual(["a", "a", "a", "a", "a", null, null, null]);
  });
});
