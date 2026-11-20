import { describe, it, expect, vi, beforeEach } from "vitest";

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn(async () => ({})) }));
vi.mock("@/../workers/client", () => ({ inngest: { send: sendMock } }));
vi.mock("@/services/settings", () => ({
  getBoolSetting: vi.fn(async () => true),
  getNumberSetting: vi.fn(async () => 0.6),
}));

const { db, calls } = vi.hoisted(() => ({
  db: {
    recent: [] as Array<Record<string, unknown>>,
    original: null as Record<string, unknown> | null,
    afterOriginal: [] as Array<Record<string, unknown>>,
  },
  calls: [] as Array<[string, unknown]>,
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: (_t: string) => ({
    from: (table: string) => {
      calls.push(["from", table]);
      const f: Record<string, unknown> = {};
      const q: Record<string, unknown> = {};
      for (const m of ["select", "neq", "lt", "filter", "order"]) q[m] = (...a: unknown[]) => { calls.push([m, a]); return q; };
      q.eq = (k: string, v: unknown) => { calls.push(["eq", [k, v]]); f[k] = v; return q; };
      q.gt = (_k: string, v: unknown) => { f.gt = v; return q; };
      q.maybeSingle = async () => ({ data: db.original, error: null });
      q.limit = async () => ({ data: f.gt ? db.afterOriginal : db.recent, error: null });
      return q;
    },
  }),
}));

import { flagPreviousReply } from "../flag-previous-reply";

const T = "22222222-2222-2222-2222-222222222222";
const TH = "33333333-3333-3333-3333-333333333333";
const NEW = "44444444-4444-4444-4444-444444444444";
const REPLY_RUN = "55555555-5555-5555-5555-555555555555";

function thread(nextBody: string) {
  db.recent = [
    { id: NEW, sender_role: "user", body: nextBody, agent_run_id: null },
    { id: "r1", sender_role: "assistant", body: "You got 42 signups.", agent_run_id: REPLY_RUN },
    { id: "u1", sender_role: "user", body: "How many signups from Meta last week?", agent_run_id: null },
  ];
}
const sent = () => ((sendMock.mock.calls[0] as unknown[])[0] as { data: Record<string, unknown> }).data;

beforeEach(() => { sendMock.mockClear(); calls.length = 0; });

describe("flagPreviousReply: normal", () => {
  it("emits a correction for the previous reply's run, no tenant_id", async () => {
    thread("No, that's wrong");
    await flagPreviousReply({ tenantId: T, threadId: TH, newUserMessageId: NEW, text: "No, that's wrong" });
    expect(sent()).toMatchObject({ run_id: REPLY_RUN, source: "correction", signals: ["founder_correction"], correction_message_id: NEW });
    expect(sent()).not.toHaveProperty("tenant_id");
    expect(calls).toContainEqual(["eq", ["thread_id", TH]]);
  });

  it("emits founder_frustration (source correction) for a fed-up follow-up with no correction words", async () => {
    const text = "Okay, this is happening repeatedly 34 times. I don't want to trust you anymore";
    thread(text);
    await flagPreviousReply({ tenantId: T, threadId: TH, newUserMessageId: NEW, text });
    expect(sent()).toMatchObject({ run_id: REPLY_RUN, source: "correction", signals: ["founder_frustration"], correction_message_id: NEW });
  });

  it("does nothing for a courtesy 'again'", async () => {
    thread("thanks again");
    await flagPreviousReply({ tenantId: T, threadId: TH, newUserMessageId: NEW, text: "thanks again" });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("does nothing for an approving follow-up", async () => {
    thread("no problem, thanks");
    await flagPreviousReply({ tenantId: T, threadId: TH, newUserMessageId: NEW, text: "no problem, thanks" });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("skips a server-authored card with no run", async () => {
    db.recent = [
      { id: NEW, sender_role: "user", body: "No, that's wrong", agent_run_id: null },
      { id: "card", sender_role: "assistant", body: "Keep this as a rule?", agent_run_id: null },
    ];
    await flagPreviousReply({ tenantId: T, threadId: TH, newUserMessageId: NEW, text: "No, that's wrong" });
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe("flagPreviousReply: barge-in", () => {
  it("targets the in-flight run on a correction", async () => {
    db.recent = [
      { id: NEW, sender_role: "user", body: "stop, that's the wrong account", agent_run_id: null },
      { id: "u1", sender_role: "user", body: "Pull last week's Meta spend", agent_run_id: null },
    ];
    await flagPreviousReply({ tenantId: T, threadId: TH, newUserMessageId: NEW, text: "stop, that's the wrong account", inFlightRunId: REPLY_RUN });
    expect(sent()).toMatchObject({ run_id: REPLY_RUN, source: "correction", correction_message_id: NEW });
  });

  it("targets the in-flight run on frustration", async () => {
    db.recent = [
      { id: NEW, sender_role: "user", body: "you keep doing the same thing again", agent_run_id: null },
      { id: "u1", sender_role: "user", body: "Pull last week's Meta spend", agent_run_id: null },
    ];
    await flagPreviousReply({ tenantId: T, threadId: TH, newUserMessageId: NEW, text: "you keep doing the same thing again", inFlightRunId: REPLY_RUN });
    expect(sent()).toMatchObject({ run_id: REPLY_RUN, source: "correction", signals: ["founder_frustration"], correction_message_id: NEW });
  });

  it("repeating the ask while it streams is not flagged", async () => {
    db.recent = [
      { id: NEW, sender_role: "user", body: "Pull last week's Meta spend", agent_run_id: null },
      { id: "u1", sender_role: "user", body: "Pull last week's Meta spend", agent_run_id: null },
    ];
    await flagPreviousReply({ tenantId: T, threadId: TH, newUserMessageId: NEW, text: "Pull last week's Meta spend", inFlightRunId: REPLY_RUN });
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe("flagPreviousReply: edit", () => {
  it("targets the reply to the ORIGINAL message, with founder_edit", async () => {
    db.original = { id: "u1", sender_role: "user", thread_id: TH, created_at: "2026-09-30T00:00:00Z" };
    db.afterOriginal = [{ id: "r1", sender_role: "assistant", agent_run_id: REPLY_RUN, meta: {} }];
    await flagPreviousReply({ tenantId: T, threadId: TH, newUserMessageId: NEW, text: "last week, not this week", editOfMessageId: "u1" });
    expect(sent()).toMatchObject({ run_id: REPLY_RUN, source: "edit", signals: ["founder_edit"], edited_message_id: "u1", correction_message_id: NEW });
  });

  it("no finished reply to the original (stopped before it answered): nothing", async () => {
    db.original = { id: "u1", sender_role: "user", thread_id: TH, created_at: "2026-09-30T00:00:00Z" };
    db.afterOriginal = [{ id: "r1", sender_role: "assistant", agent_run_id: REPLY_RUN, meta: { stopped: true } }];
    await flagPreviousReply({ tenantId: T, threadId: TH, newUserMessageId: NEW, text: "x", editOfMessageId: "u1" });
    expect(sendMock).not.toHaveBeenCalled();
  });
});

it("never throws", async () => {
  sendMock.mockRejectedValueOnce(new Error("x"));
  thread("No, that's wrong");
  await expect(flagPreviousReply({ tenantId: T, threadId: TH, newUserMessageId: NEW, text: "No, that's wrong" })).resolves.toBeUndefined();
});
