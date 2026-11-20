import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};

class Query {
  private filters: Array<(r: Row) => boolean> = [];
  private op: "select" | "update" = "select";
  private patch: Row = {};
  private single = false;
  constructor(private table: string) {}
  select() {
    return this;
  }
  update(p: Row) {
    this.op = "update";
    this.patch = p;
    return this;
  }
  eq(c: string, v: unknown) {
    this.filters.push((r) => r[c] === v);
    return this;
  }
  is(c: string, v: unknown) {
    this.filters.push((r) => (r[c] ?? null) === v);
    return this;
  }
  not(c: string, _op: string, v: unknown) {
    this.filters.push((r) => (r[c] ?? null) !== v);
    return this;
  }
  in(c: string, vs: unknown[]) {
    this.filters.push((r) => vs.includes(r[c]));
    return this;
  }
  or(expr: string) {
    if (expr !== "on_yes.is.null,on_yes->>kind.neq.hypothesis_check") throw new Error(`fake db: unexpected or(${expr})`);
    this.filters.push((r) => r.on_yes == null || (r.on_yes as { kind?: string }).kind !== "hypothesis_check");
    return this;
  }
  lte(c: string, v: string) {
    this.filters.push((r) => String(r[c] ?? "") <= v);
    return this;
  }
  order() {
    return this;
  }
  limit() {
    return this;
  }
  maybeSingle() {
    this.single = true;
    return this;
  }
  then<T>(ok: (v: { data: unknown; error: unknown }) => T) {
    const rows = db[this.table] ?? [];
    const hit = rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.op === "update") for (const r of hit) Object.assign(r, this.patch);
    const data = this.single ? (hit[0] ?? null) : hit.map((r) => ({ ...r }));
    return Promise.resolve({ data, error: null }).then(ok);
  }
}

const rpcCalls: Array<{ fn: string; args: Row }> = [];
let rpcResult: (fn: string, args: Row) => unknown = () => ({});
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({ from: (t: string) => new Query(t) }),
  tenantRpc: async (_t: string, fn: string, args: Row) => {
    rpcCalls.push({ fn, args });
    return { data: rpcResult(fn, args), error: null };
  },
}));

const applyGoalBasis = vi.fn(async (_t: string, _a: unknown, answer: string) => ({ line: answer === "yes" ? "counted from 0" : "a running number", applied_at: "2026-10-12T10:00:00.000Z" }));
const undoGoalBasis = vi.fn(async () => "back");
vi.mock("../goal-basis", () => ({ applyGoalBasis, undoGoalBasis }));

import { answerQuestions, answerQuestion, confirmationText, mapAnswers, parseAnswerReply } from "../cgo-answers";
import { undoAnsweredQuestion } from "../cgo-answers";
import { handleOneTapEmailReply } from "../cgo-email-answers";

const T = "tenant-a";
const OTHER = "tenant-b";
const Q1 = "11111111-1111-4111-8111-111111111111";
const Q2 = "22222222-2222-4222-8222-222222222222";
const noWake = { wake: async () => {} };

function q(over: Row): Row {
  return { tenant_id: T, status: "open", ask: "Should I plan for 24 a week instead of 150?", ordinal: 1, asked_at: "2026-09-28T08:00:00Z", asked_run_id: "run-1", on_yes: null, ...over };
}

beforeEach(() => {
  rpcCalls.length = 0;
  rpcResult = () => ({});
  for (const k of Object.keys(db)) delete db[k];
  db.cgo_questions = [];
  db.email_messages = [];
});

describe("answerQuestions: one writer, first surface wins", () => {
  it("two answers from Slack and email: one wins, the other is told it was already answered", async () => {
    db.cgo_questions.push(q({ id: Q1 }));
    const wake = vi.fn(async () => {});
    const [slack, email] = await Promise.all([
      answerQuestion({ tenant_id: T, question_id: Q1, answer: "yes", via: "slack", actor_user_id: "u1" }, { wake }),
      answerQuestion({ tenant_id: T, question_id: Q1, answer: "no", via: "email", actor_user_id: null }, { wake }),
    ]);
    const outcomes = [slack.outcome, email.outcome].sort();
    expect(outcomes).toEqual(["already_answered", "answered"]);
    expect(db.cgo_questions[0]).toMatchObject({ status: "answered", answer: "yes", answered_via: "slack", answered_by: "u1" });
    expect(email).toMatchObject({ outcome: "already_answered", answer: "yes", via: "slack" });
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("another tenant's question id is not found and changes nothing", async () => {
    db.cgo_questions.push(q({ id: Q1, tenant_id: OTHER }));
    const r = await answerQuestion({ tenant_id: T, question_id: Q1, answer: "yes", via: "web", actor_user_id: "u1" }, noWake);
    expect(r.outcome).toBe("not_found");
    expect(db.cgo_questions[0].status).toBe("open");
  });

  it("a yes to a question with on_yes applies exactly that change under the asking run; a no applies nothing", async () => {
    const onYes = { kind: "goal_change", goal_id: "g1", goal_rev: "rev1", change: { target_value: 24 }, why: "x" };
    db.cgo_questions.push(q({ id: Q1, on_yes: onYes }), q({ id: Q2, ordinal: 2, on_yes: onYes }));
    const apply = vi.fn(async () => 'Goal "Renters": target 150 to 24.');
    const out = await answerQuestions(
      { tenant_id: T, answers: [{ question_id: Q1, answer: "yes" }, { question_id: Q2, answer: "no" }], via: "email", actor_user_id: null },
      { ...noWake, applyApprovedGoalChange: apply },
    );
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(T, "run-1", onYes, expect.any(Date));
    expect(out[0]).toMatchObject({ outcome: "answered", applied: 'Goal "Renters": target 150 to 24.' });
    expect(db.cgo_questions[0].applied_line).toBe('Goal "Renters": target 150 to 24.');
    expect(out[1]).toMatchObject({ outcome: "answered", applied: null });
  });
});

describe("an answer in the founder's own words", () => {
  it("closes the question with the text and never applies on_yes, even when the text is 'yes'", async () => {
    const onYes = { kind: "goal_change", goal_id: "g1", goal_rev: "rev1", change: { target_value: 24 }, why: "x" };
    db.cgo_questions.push(q({ id: Q1, on_yes: onYes }), q({ id: Q2, ordinal: 2, on_yes: onYes }));
    const apply = vi.fn(async () => "applied");
    const out = await answerQuestions(
      {
        tenant_id: T,
        answers: [
          { question_id: Q1, answer: { text: "  Keep 150,   the busy season starts soon. " } },
          { question_id: Q2, answer: { text: "yes" } },
        ],
        via: "web",
        actor_user_id: "u1",
      },
      { ...noWake, applyApprovedGoalChange: apply },
    );
    expect(apply).not.toHaveBeenCalled();
    expect(out[0]).toMatchObject({ outcome: "answered", answer: "My words: Keep 150, the busy season starts soon.", applied: null });
    expect(out[1]).toMatchObject({ outcome: "answered", answer: "My words: yes", applied: null });
    expect(db.cgo_questions[1].answer).toBe("My words: yes");
    expect(db.cgo_questions[0]).toMatchObject({ status: "answered", answered_via: "web" });
    expect(db.cgo_questions[1].applied_line ?? null).toBeNull();
  });
});

describe("a yes whose change could not be tried", () => {
  it("stays answered with no applied line (the next review retries it) and never throws", async () => {
    const onYes = { kind: "goal_change", goal_id: "g1", goal_rev: "rev1", change: { target_value: 24 }, why: "x" };
    db.cgo_questions.push(q({ id: Q1, on_yes: onYes }));
    const r = await answerQuestion(
      { tenant_id: T, question_id: Q1, answer: "yes", via: "web", actor_user_id: "u1" },
      { ...noWake, applyApprovedGoalChange: async () => { throw new Error("db down"); } },
    );
    expect(r).toMatchObject({ outcome: "answered", applied: null });
    expect(db.cgo_questions[0]).toMatchObject({ status: "answered", answer: "yes" });
    expect(db.cgo_questions[0].applied_line ?? null).toBeNull();
  });
});

describe("parseAnswerReply: deterministic, whole reply or nothing", () => {
  const cases: Array<[string, unknown]> = [
    ["yes", { kind: "answers", answers: [{ ordinal: "all", answer: "yes" }] }],
    ["Yes.", { kind: "answers", answers: [{ ordinal: "all", answer: "yes" }] }],
    ["all yes", { kind: "answers", answers: [{ ordinal: "all", answer: "yes" }] }],
    ["no to all", { kind: "answers", answers: [{ ordinal: "all", answer: "no" }] }],
    ["1 yes", { kind: "answers", answers: [{ ordinal: 1, answer: "yes" }] }],
    ["1 y 2 n", { kind: "answers", answers: [{ ordinal: 1, answer: "yes" }, { ordinal: 2, answer: "no" }] }],
    ["1: yes, 2: no", { kind: "answers", answers: [{ ordinal: 1, answer: "yes" }, { ordinal: 2, answer: "no" }] }],
    ["1 yes\n2 no\n\nThanks\nRavi", { kind: "answers", answers: [{ ordinal: 1, answer: "yes" }, { ordinal: 2, answer: "no" }] }],
    ["undo 1", { kind: "undo", ordinals: [1] }],
    ["1 yes but make it 30", { kind: "free" }],
    ["what do you mean by 24?", { kind: "free" }],
    ["1 yes 1 no", { kind: "free" }],
    ["banana", { kind: "free" }],
    ["", { kind: "free" }],
  ];
  it.each(cases)("%j", (text, want) => {
    expect(parseAnswerReply(text)).toEqual(want);
  });

  it("maps only onto questions it can name exactly once; otherwise nothing", () => {
    const cands = [
      { id: Q1, ordinal: 1 },
      { id: Q2, ordinal: 2 },
    ];
    expect(mapAnswers({ kind: "answers", answers: [{ ordinal: 2, answer: "no" }] }, cands)).toEqual([{ question_id: Q2, answer: "no" }]);
    expect(mapAnswers({ kind: "answers", answers: [{ ordinal: "all", answer: "yes" }] }, cands)).toHaveLength(2);
    expect(mapAnswers({ kind: "answers", answers: [{ ordinal: 3, answer: "yes" }] }, cands)).toBeNull();
    expect(mapAnswers({ kind: "answers", answers: [{ ordinal: "all", answer: "yes" }] }, [])).toBeNull();
  });

  it("the confirmation says what it understood and how to undo a change", () => {
    const text = confirmationText([
      { question_id: Q1, outcome: "answered", ordinal: 1, ask: "a", answer: "yes", applied: 'Goal "Renters": target 150 to 24.' },
      { question_id: Q2, outcome: "answered", ordinal: 2, ask: "b", answer: "no", applied: null },
    ]);
    expect(text).toContain("Got it: 1 = Yes, 2 = No.");
    expect(text).toContain('Goal "Renters": target 150 to 24.');
    expect(text).toContain("Reply `undo 1` to reverse it.");
  });
});

describe("handleOneTapEmailReply", () => {
  const msg = { id: "m1", tenant_id: T, thread_id: "th1", from_address: "founder@x.com", envelope_to: "acme@inbox.zaviagent.com", subject: "Re: Acme: 1 question", rfc_message_id: "reply@x.com" };
  const thread = { root_message_id: "zavi-root@inbox.zaviagent.com" };
  beforeEach(() => {
    db.email_messages.push({ tenant_id: T, thread_id: "th1", direction: "out", rfc_message_id: thread.root_message_id, created_at: "2026-09-28T09:00:00Z", subject: "Acme: 1 question", body_text: "Needs you\n- 1. Should I plan for 24 a week instead of 150? (I recommend: Yes)\n" });
  });

  it("an unverified or forwarded reply answers nothing: it goes on to cgo as a comment", async () => {
    db.cgo_questions.push(q({ id: Q1 }));
    const answer = vi.fn();
    const r = await handleOneTapEmailReply(msg, thread, { founderText: async () => null, answer: answer as never, send: vi.fn() });
    expect(r).toBe("free");
    expect(answer).not.toHaveBeenCalled();
    expect(db.cgo_questions[0].status).toBe("open");
  });

  it("the founder's '1 yes' answers question 1 and confirms in the thread", async () => {
    db.cgo_questions.push(q({ id: Q1 }));
    const send = vi.fn(async () => ({}));
    const r = await handleOneTapEmailReply(msg, thread, {
      founderText: async () => "1 yes",
      answer: (a) => answerQuestions(a, noWake),
      send,
    });
    expect(r).toBe("handled");
    expect(db.cgo_questions[0]).toMatchObject({ status: "answered", answer: "yes", answered_via: "email" });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: "founder@x.com", body_text: expect.stringContaining("Got it: 1 = Yes.") }));
  });

  it("a question asked after the email being answered is never what '1 yes' means", async () => {
    db.cgo_questions.push(q({ id: Q1, asked_at: "2026-09-28T10:00:00Z" }));
    const r = await handleOneTapEmailReply(msg, thread, { founderText: async () => "1 yes", answer: (a) => answerQuestions(a, noWake), send: vi.fn() });
    expect(r).toBe("free");
    expect(db.cgo_questions[0].status).toBe("open");
  });

  it("'yes' never answers an older open question this email did not show", async () => {
    db.cgo_questions.push(q({ id: Q1 }), q({ id: Q2, ordinal: 2, ask: "Should I pause Reddit?", asked_at: "2026-09-27T08:00:00Z" }));
    const r = await handleOneTapEmailReply(msg, thread, { founderText: async () => "yes", answer: (a) => answerQuestions(a, noWake), send: vi.fn() });
    expect(r).toBe("handled");
    expect(db.cgo_questions.find((x) => x.id === Q1)!.status).toBe("answered");
    expect(db.cgo_questions.find((x) => x.id === Q2)!.status).toBe("open");
  });

  it("a number inside prose or a longer ordinal is not a shown question", async () => {
    db.email_messages[0].body_text = "What I saw\n- Last week: 1. Should I plan for 24 a week instead of 150?\n- 11. Should I plan for 24 a week instead of 150?";
    db.cgo_questions.push(q({ id: Q1 }));
    const r = await handleOneTapEmailReply(msg, thread, { founderText: async () => "yes", answer: (a) => answerQuestions(a, noWake), send: vi.fn() });
    expect(r).toBe("free");
    expect(db.cgo_questions[0].status).toBe("open");
  });

  it("'undo 1' in an old thread never reverses a later question that reused the number", async () => {
    db.cgo_questions.push(q({ id: Q2, status: "answered", answer: "yes", applied_line: "x", ask: "Should I pause Reddit?", asked_at: "2026-09-28T10:00:00Z" }));
    const undo = vi.fn(async () => "undone");
    await handleOneTapEmailReply(msg, thread, { founderText: async () => "undo 1", undo, send: vi.fn() });
    expect(undo).not.toHaveBeenCalled();
  });

  it("'undo 1' reaches a stored 'no' too (a no to how a goal counts stores a choice)", async () => {
    db.cgo_questions.push(q({ id: Q1, status: "answered", answer: "no", applied_line: "a running number" }));
    const undo = vi.fn(async () => "undone");
    await handleOneTapEmailReply(msg, thread, { founderText: async () => "undo 1", undo, send: vi.fn() });
    expect(undo).toHaveBeenCalledWith(T, Q1);
  });

  it("free text goes to cgo, never applied", async () => {
    db.cgo_questions.push(q({ id: Q1 }));
    const r = await handleOneTapEmailReply(msg, thread, { founderText: async () => "1 yes but make it 30", send: vi.fn() });
    expect(r).toBe("free");
    expect(db.cgo_questions[0].status).toBe("open");
  });
});

describe("how a goal's number counts (goal_basis)", () => {
  const onYes = { kind: "goal_basis", goal_id: "g1", goal_rev: "rev1", value_period_start: "2026-10-01", why: "x" };
  beforeEach(() => {
    applyGoalBasis.mockClear();
    undoGoalBasis.mockClear();
  });
  it("either one-tap answer stores it, as the founder who answered; own words store nothing", async () => {
    db.cgo_questions.push(q({ id: Q1, on_yes: onYes }), q({ id: Q2, ordinal: 2, on_yes: onYes }));
    const out = await answerQuestions(
      { tenant_id: T, answers: [{ question_id: Q1, answer: "yes" }, { question_id: Q2, answer: "no" }], via: "web", actor_user_id: "u1" },
      noWake,
    );
    expect(applyGoalBasis).toHaveBeenCalledWith(T, onYes, "yes", { source: "founder", user_id: "u1" }, expect.any(Date));
    expect(applyGoalBasis).toHaveBeenCalledWith(T, onYes, "no", { source: "founder", user_id: "u1" }, expect.any(Date));
    expect(out.map((o) => (o as { applied?: string | null }).applied)).toEqual(["counted from 0", "a running number"]);
    expect(db.cgo_questions[0]).toMatchObject({ applied_line: "counted from 0", on_yes: { ...onYes, applied_at: "2026-10-12T10:00:00.000Z" } });

    db.cgo_questions.push(q({ id: "33333333-3333-4333-8333-333333333333", ordinal: 3, on_yes: onYes }));
    await answerQuestions({ tenant_id: T, answers: [{ question_id: "33333333-3333-4333-8333-333333333333", answer: { text: "yes it resets monthly" } }], via: "web", actor_user_id: "u1" }, noWake);
    expect(applyGoalBasis).toHaveBeenCalledTimes(2);
  });
  it("an email answer with no signed-in user is recorded as the system acting on that reply", async () => {
    db.cgo_questions.push(q({ id: Q1, on_yes: onYes }));
    await answerQuestions({ tenant_id: T, answers: [{ question_id: Q1, answer: "yes" }], via: "email", actor_user_id: null }, noWake);
    expect(applyGoalBasis).toHaveBeenCalledWith(T, onYes, "yes", { source: "system", why: "The founder's email answer" }, expect.any(Date));
  });
  it("undo clears a stored answer, its applied line, and marks it undone so no retry stores it again", async () => {
    const stored = { ...onYes, applied_at: "2026-10-12T10:00:00.000Z" };
    db.cgo_questions.push(q({ id: Q1, on_yes: stored, status: "answered", answer: "no", applied_line: "a running number" }));
    expect(await undoAnsweredQuestion(T, Q1)).toBe("back");
    expect(undoGoalBasis).toHaveBeenCalledWith(T, stored, "no");
    expect(db.cgo_questions[0].applied_line).toBeNull();
    expect((db.cgo_questions[0].on_yes as { undone_at?: string }).undone_at).toEqual(expect.any(String));
  });
});

describe("a hypothesis question (owner call C): the answer and its effect in one transaction", () => {
  const H = "33333333-3333-4333-8333-333333333333";
  const claim = "Most hosts cancel bookings renters already paid for";
  const hq = (over: Row = {}) =>
    q({ id: Q1, topic_key: `hyp:${H}`, ask: `Is this true for your business: ${claim}?`, on_yes: { kind: "hypothesis_check", hypothesis_id: H, goal_id: "g", claim }, ...over });

  it("a one-tap yes goes through answer_hypothesis_question, never the plain update; the line is what changed", async () => {
    db.cgo_questions.push(hq());
    rpcResult = () => ({ outcome: "applied", status: "confirmed", line: `Marked as true for your business: "${claim}".` });
    const wake = vi.fn(async () => {});
    const r = await answerQuestion({ tenant_id: T, question_id: Q1, answer: "yes", via: "slack", actor_user_id: "u1" }, { wake });
    expect(rpcCalls).toEqual([
      { fn: "answer_hypothesis_question", args: { p_tenant_id: T, p_question_id: Q1, p_kind: "yes", p_answer: "yes", p_words: null, p_via: "slack", p_actor: "u1" } },
    ]);
    expect(r).toMatchObject({ outcome: "answered", answer: "yes", applied: expect.stringContaining(claim), note: null });
    expect(db.cgo_questions[0].status).toBe("open");
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("own words are sent as the founder's words, never applied as a tap", async () => {
    db.cgo_questions.push(hq());
    rpcResult = () => ({ outcome: "applied", status: "testing", line: null });
    await answerQuestion({ tenant_id: T, question_id: Q1, answer: { text: "  yes, but only on weekends " }, via: "web", actor_user_id: "u1" }, noWake);
    expect(rpcCalls[0].args).toMatchObject({ p_kind: "words", p_answer: "My words: yes, but only on weekends", p_words: "  yes, but only on weekends " });
  });

  it("a hypothesis that moved on since the ask: nothing changed, the founder is told so, cgo is not woken, no undo offered", async () => {
    db.cgo_questions.push(hq());
    rpcResult = () => ({ outcome: "stale", reason: "ruled_out" });
    const wake = vi.fn(async () => {});
    const r = await answerQuestion({ tenant_id: T, question_id: Q1, answer: "yes", via: "email", actor_user_id: null }, { wake });
    expect(r).toMatchObject({ outcome: "answered", applied: null, note: "Nothing changed: that idea was already ruled out." });
    expect(wake).not.toHaveBeenCalled();
    const text = confirmationText([r]);
    expect(text).toContain("Nothing changed: that idea was already ruled out.");
    expect(text).not.toContain("Got it");
    expect(text).not.toContain("acting on your answers");
    expect(text).not.toContain("undo");
  });

  it("answered first on another surface: already answered, from the stored row", async () => {
    db.cgo_questions.push(hq({ status: "answered", answer: "no", answered_via: "slack", answered_at: "2026-10-12T09:00:00Z" }));
    rpcResult = () => ({ outcome: "not_open" });
    const r = await answerQuestion({ tenant_id: T, question_id: Q1, answer: "yes", via: "email", actor_user_id: null }, noWake);
    expect(r).toMatchObject({ outcome: "already_answered", answer: "no", via: "slack" });
  });

  it("undo goes through undo_hypothesis_answer and says any work already started keeps going", async () => {
    db.cgo_questions.push(hq({ status: "answered", answer: "yes", applied_line: "Marked as true" }));
    rpcResult = () => ({ outcome: "undone", claim });
    expect(await undoAnsweredQuestion(T, Q1)).toBe(`"${claim}" is open again. Any work already started from your answer keeps going.`);
    expect(rpcCalls).toEqual([{ fn: "undo_hypothesis_answer", args: { p_tenant_id: T, p_question_id: Q1 } }]);
    rpcResult = () => ({ outcome: "changed" });
    expect(await undoAnsweredQuestion(T, Q1)).toBeNull();
  });

  it("email: a blanket 'yes' next to a claim about the founder's records answers nothing and says which reply counts; '2 yes' does", async () => {
    const thread = { root_message_id: "zavi-root@inbox.zaviagent.com" };
    const msg = { id: "m1", tenant_id: T, thread_id: "th1", from_address: "founder@x.com", envelope_to: "acme@inbox.zaviagent.com", subject: "Re", rfc_message_id: "r@x" };
    db.email_messages.push({
      tenant_id: T, thread_id: "th1", direction: "out", rfc_message_id: thread.root_message_id, created_at: "2026-09-28T09:00:00Z", subject: "Acme",
      body_text: `Needs you\n- 1. Should I plan for 24 a week instead of 150?\n- 2. Is this true for your business: ${claim}?\n`,
    });
    db.cgo_questions.push(q({ id: Q2, topic_key: "goal:x" }), hq({ ordinal: 2 }));
    rpcResult = () => ({ outcome: "applied", status: "confirmed", line: "Marked as true" });
    const send = vi.fn(async () => ({}));
    expect(await handleOneTapEmailReply(msg, thread, { founderText: async () => "yes", answer: (a) => answerQuestions(a, noWake), send })).toBe("handled");
    expect(db.cgo_questions.find((x) => x.id === Q2)!.status).toBe("open");
    expect(rpcCalls).toEqual([]);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ body_text: expect.stringContaining("reply `2 yes` or `2 no`") }));
    await handleOneTapEmailReply(msg, thread, { founderText: async () => "2 yes", answer: (a) => answerQuestions(a, noWake), send: vi.fn() });
    expect(rpcCalls.map((c) => [c.fn, c.args.p_kind])).toEqual([["answer_hypothesis_question", "yes"]]);
  });
});

describe("Not now, and the next question opening", () => {
  it("'Not now' closes the question unanswered, wakes no review, and opens the oldest queued one", async () => {
    db.cgo_questions.push(q({ id: Q1 }), q({ id: Q2, status: "queued", ordinal: null, asked_at: "2026-09-29T08:00:00Z", topic_key: "later" }));
    const wake = vi.fn(async () => {});
    const now = new Date("2026-10-13T10:00:00Z");
    const r = await answerQuestion({ tenant_id: T, question_id: Q1, answer: "not_now", via: "web", actor_user_id: "u1", now }, { wake });
    expect(r).toMatchObject({ outcome: "answered", answer: "not_now", applied: null });
    expect(db.cgo_questions[0]).toMatchObject({ status: "answered", answer: "not_now", answered_via: "web" });
    expect(wake).not.toHaveBeenCalled();
    expect(db.cgo_questions[1]).toMatchObject({ status: "open", ordinal: 1, asked_at: now.toISOString() });
  });

  it("a claim about the founder's own records cannot be skipped", async () => {
    db.cgo_questions.push(q({ id: Q1, topic_key: "hyp:h1", on_yes: { kind: "hypothesis_check", hypothesis_id: "h1", goal_id: "g1", claim: "c" } }));
    const r = await answerQuestion({ tenant_id: T, question_id: Q1, answer: "not_now", via: "web", actor_user_id: "u1" }, noWake);
    expect(r.outcome).toBe("not_found");
    expect(db.cgo_questions[0].status).toBe("open");
    expect(rpcCalls).toEqual([]);
  });
});

describe("the founder's 'Yes, go ahead.' (upcar-ai 2026-10-22)", () => {
  it("is a yes after the sign-off is cut, with or without the comma", () => {
    expect(parseAnswerReply("Yes, go ahead.\n\nRegards,\nRavi")).toEqual({ kind: "answers", answers: [{ ordinal: "all", answer: "yes" }] });
    expect(parseAnswerReply("yes go ahead")).toEqual({ kind: "answers", answers: [{ ordinal: "all", answer: "yes" }] });
    expect(parseAnswerReply("Yes, please!")).toEqual({ kind: "answers", answers: [{ ordinal: "all", answer: "yes" }] });
    expect(parseAnswerReply("Yes, go ahead but only to $160")).toEqual({ kind: "free" });
    expect(parseAnswerReply("No, go ahead")).toEqual({ kind: "free" });
  });
});

describe("a yes to a held ad order (on_yes held_ad_order)", () => {
  const onYes = {
    kind: "held_ad_order",
    exec_class: "meta_ads.update_ad_set_budget",
    payload: { ad_set_id: "120258729006520059", daily_budget_usd: 178.8, expected_current_daily_budget_usd: 149 },
    object_id: "120258729006520059",
    from_usd: 149,
    to_usd: 178.8,
  };
  const ask = 'I did not apply "Raise the ad set from $149 to $178.80 a day" on my own: you set its budget yourself in the last 30 days. Should I apply it?';

  it("one tap applies it once, as the person who answered; a second yes is already answered and applies nothing", async () => {
    db.cgo_questions.push(q({ id: Q1, ask, on_yes: onYes }));
    const applyHeldOrder = vi.fn(async () => ({ line: "Approved: Raise the ad set from $149 to $178.80 a day.", refused: null, reask: false as const }));
    const [first] = await answerQuestions({ tenant_id: T, answers: [{ question_id: Q1, answer: "yes" }], via: "email", actor_user_id: null }, { ...noWake, applyHeldOrder });
    expect(applyHeldOrder).toHaveBeenCalledTimes(1);
    expect(applyHeldOrder).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: T, question: { id: Q1, on_yes: onYes }, approver_user_id: null, via: "email" }));
    expect(first).toMatchObject({ outcome: "answered", applied: "Approved: Raise the ad set from $149 to $178.80 a day.", undoable: false });
    expect(db.cgo_questions[0]).toMatchObject({ status: "answered", applied_line: "Approved: Raise the ad set from $149 to $178.80 a day." });
    expect(confirmationText([first])).not.toContain("undo");

    const [second] = await answerQuestions({ tenant_id: T, answers: [{ question_id: Q1, answer: "yes" }], via: "slack", actor_user_id: "u1" }, { ...noWake, applyHeldOrder });
    expect(second.outcome).toBe("already_answered");
    expect(applyHeldOrder).toHaveBeenCalledTimes(1);
  });

  it("'no' and own words apply nothing", async () => {
    db.cgo_questions.push(q({ id: Q1, ask, on_yes: onYes }), q({ id: Q2, ordinal: 2, ask, on_yes: onYes }));
    const applyHeldOrder = vi.fn();
    await answerQuestions({ tenant_id: T, answers: [{ question_id: Q1, answer: "no" }, { question_id: Q2, answer: { text: "yes" } }], via: "web", actor_user_id: "u1" }, { ...noWake, applyHeldOrder: applyHeldOrder as never });
    expect(applyHeldOrder).not.toHaveBeenCalled();
    expect(db.cgo_questions.map((r) => r.applied_line ?? null)).toEqual([null, null]);
  });

  it("a budget that moved: nothing changed, the founder is told why, and the question is withdrawn so it can be asked again", async () => {
    db.cgo_questions.push(q({ id: Q1, ask, on_yes: onYes }));
    const applyHeldOrder = vi.fn(async () => ({ line: null, refused: "the budget is $160.00 a day now, not the $149.00 I asked about", reask: true }));
    const wake = vi.fn(async () => {});
    const [o] = await answerQuestions({ tenant_id: T, answers: [{ question_id: Q1, answer: "yes" }], via: "web", actor_user_id: "u1" }, { wake, applyHeldOrder });
    expect(o).toMatchObject({ outcome: "answered", applied: null, note: "Nothing changed: the budget is $160.00 a day now, not the $149.00 I asked about. I'll ask again with the numbers as they are now." });
    expect(db.cgo_questions[0]).toMatchObject({ status: "withdrawn" });
    expect(db.cgo_questions[0].applied_line ?? null).toBeNull();
    expect(wake).not.toHaveBeenCalled();
  });
});

describe("a held order whose question could not be withdrawn", () => {
  it("never promises to ask again", async () => {
    db.cgo_questions.push(q({ id: Q1, ask: "Should I apply it?", on_yes: { kind: "held_ad_order" } }));
    const applyHeldOrder = vi.fn(async () => {
      db.cgo_questions[0].status = "expired";
      return { line: null, refused: "the budget moved", reask: true };
    });
    const [o] = await answerQuestions({ tenant_id: T, answers: [{ question_id: Q1, answer: "yes" }], via: "web", actor_user_id: "u1" }, { ...noWake, applyHeldOrder });
    expect(o).toMatchObject({ note: "Nothing changed: the budget moved." });
  });
});

describe("a yes again after a first yes that applied nothing (crash after the answer was saved)", () => {
  it("applies it now; once applied, a further yes does nothing", async () => {
    db.cgo_questions.push(q({ id: Q1, status: "answered", answer: "yes", applied_line: null, ask: "Should I apply it?", on_yes: { kind: "held_ad_order" } }));
    const applyHeldOrder = vi.fn(async () => ({ line: "Approved: the raise.", refused: null, reask: false as const }));
    const [o] = await answerQuestions({ tenant_id: T, answers: [{ question_id: Q1, answer: "yes" }], via: "slack", actor_user_id: "u1" }, { ...noWake, applyHeldOrder });
    expect(o).toMatchObject({ outcome: "answered", applied: "Approved: the raise." });
    expect(db.cgo_questions[0].applied_line).toBe("Approved: the raise.");
    const [again] = await answerQuestions({ tenant_id: T, answers: [{ question_id: Q1, answer: "yes" }], via: "slack", actor_user_id: "u1" }, { ...noWake, applyHeldOrder });
    expect(again.outcome).toBe("already_answered");
    expect(applyHeldOrder).toHaveBeenCalledTimes(1);
  });
});

describe("a held raise whose month ran past the cap after it was asked (Ravi 2026-10-29, review F1-F3)", () => {
  const refused = "This puts you on track for $29,314 this month, $914 over your $28,400 cap. Approve it on its card to raise it anyway";

  it("a yes applies nothing, tells the founder the cap numbers and where to approve, and the question stays answered with no applied line", async () => {
    db.cgo_questions.push(q({ id: Q1, ask: "Should I apply it?", on_yes: { kind: "held_ad_order" } }));
    const applyHeldOrder = vi.fn(async () => ({ line: null, refused, reask: false }));
    const [o] = await answerQuestions({ tenant_id: T, answers: [{ question_id: Q1, answer: "yes" }], via: "email", actor_user_id: null }, { ...noWake, applyHeldOrder });
    expect(o).toMatchObject({ outcome: "answered", applied: null, note: `Nothing changed: ${refused}.` });
    expect(db.cgo_questions[0]).toMatchObject({ status: "answered", answer: "yes" });
    expect(db.cgo_questions[0].applied_line ?? null).toBeNull();
  });

  it("two yeses at once (a duplicate tap or reply): neither applies; the second re-runs the same check (held-order-yes reuses the one card)", async () => {
    db.cgo_questions.push(q({ id: Q1, ask: "Should I apply it?", on_yes: { kind: "held_ad_order" } }));
    const applyHeldOrder = vi.fn(async () => ({ line: null, refused, reask: false }));
    const call = (via: "email" | "slack") => answerQuestions({ tenant_id: T, answers: [{ question_id: Q1, answer: "yes" }], via, actor_user_id: via === "slack" ? "u1" : null }, { ...noWake, applyHeldOrder });
    const outs = (await Promise.all([call("email"), call("slack")])).flat();
    expect(outs.filter((o) => (o as { applied?: unknown }).applied)).toHaveLength(0);
    expect(db.cgo_questions[0]).toMatchObject({ status: "answered" });
    expect(db.cgo_questions[0].applied_line ?? null).toBeNull();
  });
});

describe("handleOneTapEmailReply: a note with one unnumbered question", () => {
  const msg = { id: "m1", tenant_id: T, thread_id: "th1", from_address: "founder@x.com", envelope_to: "acme@inbox.zaviagent.com", subject: "Re: Acme: 1 question", rfc_message_id: "reply@x.com" };
  const thread = { root_message_id: "zavi-root@inbox.zaviagent.com" };
  const ask = "Should I raise the ad set from $149 to $178.80 a day?";
  const root = (body: string) => db.email_messages.push({ tenant_id: T, thread_id: "th1", direction: "out", rfc_message_id: thread.root_message_id, created_at: "2026-09-28T09:00:00Z", subject: "Acme: 1 question", body_text: body });

  it("'Yes, go ahead.' answers the one question the email printed without a number", async () => {
    root(`Acme: 1 question\n\nNeeds you\n- ${ask}\n\nJust reply to this email to answer.`);
    db.cgo_questions.push(q({ id: Q1, ordinal: 7, ask }));
    const r = await handleOneTapEmailReply(msg, thread, { founderText: async () => "Yes, go ahead.\n\nRegards,\nRavi", answer: (a) => answerQuestions(a, noWake), send: vi.fn(async () => ({})) });
    expect(r).toBe("handled");
    expect(db.cgo_questions[0]).toMatchObject({ status: "answered", answer: "yes", answered_via: "email" });
  });

  it("two open questions printed unnumbered, or a numbered one beside it: nothing is guessed", async () => {
    root(`Needs you\n- ${ask}\n- ${ask}`);
    db.cgo_questions.push(q({ id: Q1, ordinal: 7, ask }), q({ id: Q2, ordinal: 8, ask }));
    expect(await handleOneTapEmailReply(msg, thread, { founderText: async () => "yes", answer: (a) => answerQuestions(a, noWake), send: vi.fn() })).toBe("free");

    db.email_messages.length = 0;
    db.cgo_questions.length = 0;
    root(`Needs you\n- 1. Should I pause Reddit?\n- ${ask}`);
    db.cgo_questions.push(q({ id: Q1, ordinal: 7, ask }));
    expect(await handleOneTapEmailReply(msg, thread, { founderText: async () => "yes", answer: (a) => answerQuestions(a, noWake), send: vi.fn() })).toBe("free");
    expect(db.cgo_questions[0].status).toBe("open");
  });
});
