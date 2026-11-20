import { describe, it, expect, vi, beforeEach } from "vitest";
import type { JudgeUsage, JudgeVerdict } from "@/services/team-notes/judge";

const { sentEvents } = vi.hoisted(() => ({ sentEvents: [] as Array<{ name: string; data: Record<string, unknown> }> }));
vi.mock("../../client", () => ({
  inngest: {
    createFunction: (c: unknown, _t: unknown, f: unknown) => ({ config: c, handler: f }),
    send: async (e: { name: string; data: Record<string, unknown> }) => { sentEvents.push(e); return {}; },
  },
}));
const { chatThread } = vi.hoisted(() => ({ chatThread: { rows: [] as Array<Record<string, unknown>> } }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "filter", "order"]) q[m] = () => q;
      q.limit = async () => ({ data: chatThread.rows, error: null });
      return q;
    },
  }),
}));

const { db } = vi.hoisted(() => ({
  db: {
    run: null as Record<string, unknown> | null,
    reply: null as Record<string, unknown> | null,
    ask: null as Record<string, unknown> | null,
    correction: null as Record<string, unknown> | null,
    replyAppearsAfterPolls: 0,
    polls: 0,
  },
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      const f: Record<string, unknown> = {};
      const q: Record<string, unknown> = {
        select: () => q, filter: () => q, order: () => q, limit: () => q,
        eq: (k: string, v: unknown) => { f[k] = v; return q; },
        maybeSingle: async () => {
          if (table === "agent_runs") return { data: db.run, error: null };
          if (f.agent_run_id) {
            db.polls += 1;
            return { data: db.polls > db.replyAppearsAfterPolls ? db.reply : null, error: null };
          }
          if (f.id === (db.run?.payload as { user_message_id?: string })?.user_message_id) return { data: db.ask, error: null };
          return { data: db.correction, error: null };
        },
      };
      return q;
    },
  }),
}));

const { store } = vi.hoisted(() => {
  const claimed = new Set<string>();
  return {
    store: {
      __claimed: claimed,
      canOffer: vi.fn(async (_t: string, _m: string, _o?: { applyCaps: boolean }): Promise<string> => "ok"),
      claimJudgement: vi.fn(async (_t: string, m: string, _s?: string, _sig?: string[], _hard?: boolean): Promise<string> => {
        if (claimed.has(m)) return "taken";
        claimed.add(m);
        return "claimed";
      }),
      offerNote: vi.fn(async (_t: string, _a: Record<string, unknown>): Promise<{ offered: boolean; reason?: string; offer_id?: string }> => ({ offered: true, offer_id: "o1" })),
      promoteNote: vi.fn(async (): Promise<{ promoted: boolean; reason?: string }> => ({ promoted: true })),
      recordJudgement: vi.fn(async (_t: string, _a: Record<string, unknown>): Promise<boolean> => true),
    },
  };
});
vi.mock("@/services/team-notes/store", () => store);
const { judge } = vi.hoisted(() => ({
  judge: {
    judgeWith: vi.fn(async (): Promise<{ verdict: JudgeVerdict; usage: JudgeUsage | null }> => ({ verdict: { bad: true, signal: "tool_failure", note: "The tool failed twice." }, usage: { input_tokens: 100, output_tokens: 20 } })),
    haikuTransport: vi.fn(() => async () => ({ text: "", usage: { input_tokens: 0, output_tokens: 0 } })),
  },
}));
vi.mock("@/services/team-notes/judge", () => judge);
const settings = vi.hoisted(() => ({ getBoolSetting: vi.fn(async () => true), getNumberSetting: vi.fn(async (k: string) => (k === "team_note_tool_loop_threshold" ? 3 : k === "team_note_tool_thrash_threshold" ? 10 : 0.6)) }));
vi.mock("@/services/settings", () => settings);
const { logs } = vi.hoisted(() => ({ logs: [] as Array<Record<string, unknown>> }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async (e: Record<string, unknown>) => { logs.push(e); }) }));

import { teamNoteJudgeFn } from "../team-note-judge";
import { flagPreviousReply } from "@/services/team-notes/flag-previous-reply";

const fn = teamNoteJudgeFn as unknown as { config: Record<string, unknown>; handler: (ctx: unknown) => Promise<unknown> };
const step = { run: async (_n: string, f: () => unknown) => f(), sleep: vi.fn(async () => {}) };
const T = "22222222-2222-2222-2222-222222222222";
const RUN = "55555555-5555-5555-5555-555555555555";

beforeEach(() => {
  vi.clearAllMocks();
  store.__claimed.clear();
  logs.length = 0;
  sentEvents.length = 0;
  db.polls = 0; db.replyAppearsAfterPolls = 0;
  db.run = { id: RUN, tenant_id: T, agent_slug: "operator", trigger: "chat", status: "success", payload: { thread_id: "th", user_message_id: "u1" } };
  db.reply = { id: "m1", tenant_id: T, thread_id: "th", sender_role: "assistant", body: "reply", created_at: "2026-09-30T00:00:01Z", meta: {} };
  db.ask = { id: "u1", tenant_id: T, thread_id: "th", sender_role: "user", body: "ask", created_at: "2026-09-30T00:00:00Z" };
  db.correction = { id: "c1", tenant_id: T, thread_id: "th", sender_role: "user", body: "No, that's wrong", created_at: "2026-09-30T00:00:02Z" };
});

const ev = (data: Record<string, unknown>) => ({ event: { data }, step, logger: { info: () => {}, warn: () => {} } });
const RUN_END = { run_id: RUN, source: "run_end", signals: ["tool_repeat_failure"], fingerprint: "0123456789abcdef" };
const CORRECTION = { run_id: RUN, source: "correction", signals: ["founder_correction"], fingerprint: "0123456789abcdef", correction_message_id: "c1" };

describe("team-note-judge", () => {
  it("serializes per run, dedups per (run, source)", () => {
    expect(fn.config.concurrency).toEqual({ key: "event.data.run_id", limit: 1 });
    expect(fn.config.idempotency).toBe("event.data.run_id + '-' + event.data.source");
  });

  it("re-derives the tenant from the run row, claims, judges, drafts", async () => {
    await fn.handler(ev(RUN_END));
    expect(store.canOffer).toHaveBeenCalledWith(T, "m1", { applyCaps: false });
    expect(store.claimJudgement).toHaveBeenCalledWith(T, "m1", "run_end", ["tool_repeat_failure"], false);
    expect(store.offerNote).toHaveBeenCalledWith(T, expect.objectContaining({ messageId: "m1", signal: "tool_failure", note: "The tool failed twice." }));
  });

  it("simultaneous run-end + correction: ONE judge call, ONE offer (R7)", async () => {
    await Promise.all([fn.handler(ev(RUN_END)), fn.handler(ev(CORRECTION))]);
    expect(judge.judgeWith).toHaveBeenCalledTimes(1);
    expect(store.offerNote).toHaveBeenCalledTimes(1);
    expect(logs.some((l) => l.code === "team_note.skip.already_judged")).toBe(true);
  });

  it("signal precedence is deterministic: primary = highest precedence, not arrival order", async () => {
    await fn.handler(ev({ ...RUN_END, signals: ["tool_repeat_failure", "run_failed", "hard_grounding_flag"] }));
    const input = (judge.judgeWith.mock.calls[0] as unknown[])[0] as { signals: string[] };
    expect(input.signals).toEqual(["run_failed", "hard_grounding_flag", "tool_repeat_failure"]);
  });

  it("logs judge token usage with whitelisted keys only", async () => {
    await fn.handler(ev(RUN_END));
    const usage = logs.find((l) => l.code === "team_note.judge_usage")!;
    expect(usage.meta).toEqual({ agent_slug: "operator", stage: "judge", input_tokens: 100, output_tokens: 20 });
  });

  it("ignores a tenant_id smuggled into the event", async () => {
    await fn.handler(ev({ ...RUN_END, tenant_id: "99999999-9999-9999-9999-999999999999" }));
    expect(store.canOffer).toHaveBeenCalledWith(T, "m1", { applyCaps: false });
  });

  it("skips non-chat runs", async () => {
    db.run = { ...db.run!, trigger: "slack" };
    await fn.handler(ev(RUN_END));
    expect(judge.judgeWith).not.toHaveBeenCalled();
  });

  it("waits (bounded) for a reply to land, then judges", async () => {
    db.replyAppearsAfterPolls = 2;
    await fn.handler(ev(CORRECTION));
    expect(step.sleep).toHaveBeenCalledTimes(2);
    expect(judge.judgeWith).toHaveBeenCalled();
  });

  it("gives up quietly when the reply never lands", async () => {
    db.replyAppearsAfterPolls = 99;
    await fn.handler(ev(RUN_END));
    expect(judge.judgeWith).not.toHaveBeenCalled();
  });

  it("skips a stopped reply", async () => {
    db.reply = { ...db.reply!, meta: { stopped: true } };
    await fn.handler(ev(RUN_END));
    expect(judge.judgeWith).not.toHaveBeenCalled();
  });

  it("kill switch turned off during the reply wait: no claim, no model call (re-read before judging)", async () => {
    settings.getBoolSetting.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await fn.handler(ev(RUN_END));
    expect(store.claimJudgement).not.toHaveBeenCalled();
    expect(judge.judgeWith).not.toHaveBeenCalled();
    expect(logs.some((l) => l.code === "team_note.skip.disabled")).toBe(true);
  });

  it("kill switch turned off after the claim: still no model call (flag read inside the judge step)", async () => {
    settings.getBoolSetting.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await fn.handler(ev(RUN_END));
    expect(store.claimJudgement).toHaveBeenCalled();
    expect(judge.judgeWith).not.toHaveBeenCalled();
    expect(store.offerNote).not.toHaveBeenCalled();
  });

  it("no model call when shown-caps say no; no claim taken either", async () => {
    store.canOffer.mockResolvedValueOnce("daily_cap");
    await fn.handler(ev(RUN_END));
    expect(store.claimJudgement).not.toHaveBeenCalled();
    expect(judge.judgeWith).not.toHaveBeenCalled();
  });

  it("judge says not bad: no draft, no failure log", async () => {
    judge.judgeWith.mockResolvedValueOnce({ verdict: { bad: false }, usage: { input_tokens: 1, output_tokens: 1 } });
    await fn.handler(ev(RUN_END));
    expect(store.offerNote).not.toHaveBeenCalled();
    expect(logs.some((l) => String(l.code).startsWith("team_note.judge_failed"))).toBe(false);
  });

  it("judge transport failure: no draft, structured log only", async () => {
    judge.judgeWith.mockResolvedValueOnce({ verdict: { bad: false, failed: "transport" }, usage: null });
    await fn.handler(ev(RUN_END));
    expect(store.offerNote).not.toHaveBeenCalled();
    expect(logs.find((l) => l.code === "team_note.judge_failed.transport")).toMatchObject({ run_id: RUN, meta: { agent_slug: "operator", stage: "judge" } });
  });

  it("an unexpected error is logged as team_note.worker_error and rethrown for the one Inngest retry", async () => {
    store.offerNote.mockRejectedValueOnce(new Error("db down"));
    await expect(fn.handler(ev(RUN_END))).rejects.toThrow("db down");
    expect(logs.some((l) => l.code === "team_note.worker_error")).toBe(true);
  });

  it("correction from another thread is refused", async () => {
    db.correction = { ...db.correction!, thread_id: "OTHER" };
    await fn.handler(ev(CORRECTION));
    expect(judge.judgeWith).not.toHaveBeenCalled();
  });

  it("edit: the run must be the reply to the edited message", async () => {
    await fn.handler(ev({ run_id: RUN, source: "edit", signals: ["founder_edit"], fingerprint: "0123456789abcdef", correction_message_id: "c1", edited_message_id: "NOT_u1" }));
    expect(judge.judgeWith).not.toHaveBeenCalled();
  });

  it("frustration end to end: a fed-up follow-up with no correction words reaches the judge (2026-09-30 postmortem)", async () => {
    const text = "Okay, this is happening repeatedly 34 times. I don't want to trust you anymore";
    db.correction = { id: "c1", tenant_id: T, thread_id: "th", sender_role: "user", body: text, created_at: "2026-09-30T00:00:02Z" };
    chatThread.rows = [
      { id: "c1", sender_role: "user", body: text, agent_run_id: null },
      { id: "m1", sender_role: "assistant", body: "reply", agent_run_id: RUN },
      { id: "u1", sender_role: "user", body: "ask", agent_run_id: null },
    ];
    judge.judgeWith.mockResolvedValueOnce({
      verdict: { bad: true, signal: "lost_founder_trust", note: "The founder says the same failure happened 34 times." },
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    await flagPreviousReply({ tenantId: T, threadId: "th", newUserMessageId: "c1", text });
    expect(sentEvents).toHaveLength(1);
    expect(sentEvents[0]).toMatchObject({
      name: "team_note.candidate",
      data: { run_id: RUN, source: "correction", signals: ["founder_frustration"], correction_message_id: "c1" },
    });

    await fn.handler(ev(sentEvents[0].data));
    expect(store.claimJudgement).toHaveBeenCalledWith(T, "m1", "correction", ["founder_frustration"], false);
    expect(judge.judgeWith).toHaveBeenCalledTimes(1);
    expect((judge.judgeWith.mock.calls[0] as unknown[])[0]).toEqual({
      ask: "ask", reply: "reply", correction: text, signals: ["founder_frustration"], runFacts: [],
    });
    expect(store.offerNote).toHaveBeenCalledWith(T, expect.objectContaining({
      messageId: "m1", source: "correction", signal: "lost_founder_trust", signals: ["founder_frustration"],
      surface: "strip", anchorMessageId: "c1",
    }));
  });

  it("a courtesy 'thanks again' emits nothing, so the judge never runs", async () => {
    chatThread.rows = [
      { id: "c1", sender_role: "user", body: "thanks again", agent_run_id: null },
      { id: "m1", sender_role: "assistant", body: "reply", agent_run_id: RUN },
      { id: "u1", sender_role: "user", body: "ask", agent_run_id: null },
    ];
    await flagPreviousReply({ tenantId: T, threadId: "th", newUserMessageId: "c1", text: "thanks again" });
    expect(sentEvents).toHaveLength(0);
  });

  it("a looping run's run_end event (tool_loop) is judged WITH run facts re-derived from agent_runs", async () => {
    db.run = { ...db.run!, tool_calls: Array.from({ length: 34 }, () => ({ name: "operator_db__query", status: "ok", input_preview: "SECRET_SQL", output_preview: "SECRET_ROWS" })) };
    await fn.handler(ev({ ...RUN_END, signals: ["tool_loop", "tool_thrash"] }));
    const input = (judge.judgeWith.mock.calls[0] as unknown[])[0] as { signals: string[]; runFacts: string[] };
    expect(input.signals).toEqual(["tool_loop", "tool_thrash"]);
    expect(input.runFacts).toEqual(["tool operator_db__query called 34 times, 34 ok, 0 failed, same input 34 times"]);
    expect(JSON.stringify(input.runFacts)).not.toMatch(/SECRET/);
    expect(store.offerNote).toHaveBeenCalled();
  });

  it("run facts come from the run row, not the event (event-supplied facts are ignored)", async () => {
    db.run = { ...db.run!, tool_calls: [] };
    await fn.handler(ev({ ...RUN_END, signals: ["tool_loop"], runFacts: ["tool fake called 999 times"] }));
    const input = (judge.judgeWith.mock.calls[0] as unknown[])[0] as { runFacts: string[] };
    expect(input.runFacts).toEqual([]);
  });

  describe("surface, anchor and caps (quiet + precise)", () => {
    const failedRun = (error: string, status = "failed") => { db.run = { ...db.run!, status, error }; };

    it("a recovered-or-not tool failure on a successful run is a FLAG: no anchor, no caps", async () => {
      await fn.handler(ev(RUN_END));
      expect(store.canOffer).toHaveBeenCalledWith(T, "m1", { applyCaps: false });
      expect(store.offerNote).toHaveBeenCalledWith(T, expect.objectContaining({ surface: "flag", anchorMessageId: null }));
    });

    it("a hard run failure (from the run row) is a STRIP anchored on the reply, and spends caps", async () => {
      failedRun("tool crashed mid-reply");
      await fn.handler(ev({ ...RUN_END, signals: ["run_failed"] }));
      expect(store.canOffer).toHaveBeenCalledWith(T, "m1", { applyCaps: true });
      expect(store.claimJudgement).toHaveBeenCalledWith(T, "m1", "run_end", ["run_failed"], true);
      expect(store.offerNote).toHaveBeenCalledWith(T, expect.objectContaining({ surface: "strip", anchorMessageId: "m1" }));
    });

    it.each([
      ["an infra reap", "watchdog_reap: no progress for >30min"],
      ["provider capacity", "anthropic 529 overloaded"],
    ])("a run that failed because of %s is only a flag", async (_l, error) => {
      failedRun(error, "dispatch_error");
      await fn.handler(ev({ ...RUN_END, signals: ["run_failed"] }));
      expect(store.offerNote).toHaveBeenCalledWith(T, expect.objectContaining({ surface: "flag", anchorMessageId: null }));
      expect(store.claimJudgement).toHaveBeenCalledWith(T, "m1", "run_end", ["run_failed"], false);
    });

    it("the error class comes from the run row, never the event: a success row never earns a strip", async () => {
      await fn.handler(ev({ ...RUN_END, signals: ["run_failed"], error: "tool crashed", status: "failed" }));
      expect(store.offerNote).toHaveBeenCalledWith(T, expect.objectContaining({ surface: "flag" }));
    });

    it("pushback is a STRIP anchored on the founder's message, caps skipped", async () => {
      await fn.handler(ev(CORRECTION));
      expect(store.canOffer).toHaveBeenCalledWith(T, "m1", { applyCaps: false });
      expect(store.offerNote).toHaveBeenCalledWith(T, expect.objectContaining({ surface: "strip", anchorMessageId: "c1", source: "correction" }));
    });

    it("rephrase is a flag with no anchor", async () => {
      await fn.handler(ev({ run_id: RUN, source: "rephrase", signals: ["founder_rephrase"], fingerprint: "0123456789abcdef", correction_message_id: "c1" }));
      expect(store.offerNote).toHaveBeenCalledWith(T, expect.objectContaining({ surface: "flag", anchorMessageId: null }));
    });

    it("pushback on a reply that already has a note: promote, no model call", async () => {
      store.canOffer.mockResolvedValueOnce("already_offered");
      const r = await fn.handler(ev(CORRECTION));
      expect(store.promoteNote).toHaveBeenCalledWith(T, { messageId: "m1", anchorMessageId: "c1", signals: ["founder_correction"] });
      expect(judge.judgeWith).not.toHaveBeenCalled();
      expect(store.claimJudgement).not.toHaveBeenCalled();
      expect(r).toMatchObject({ promoted: true });
      expect(logs.some((l) => l.code === "team_note.promoted")).toBe(true);
    });

    it("an already-offered run_end reply is NOT promoted", async () => {
      store.canOffer.mockResolvedValueOnce("already_offered");
      await fn.handler(ev(RUN_END));
      expect(store.promoteNote).not.toHaveBeenCalled();
      expect(logs.some((l) => l.code === "team_note.skip.already_offered")).toBe(true);
    });

    it("pushback that loses the race to the other event's draft still promotes (claim says offered)", async () => {
      store.claimJudgement.mockResolvedValueOnce("offered");
      await fn.handler(ev(CORRECTION));
      expect(store.promoteNote).toHaveBeenCalledTimes(1);
      expect(judge.judgeWith).not.toHaveBeenCalled();
    });

    it("pushback whose own draft collides with the other event's draft promotes it", async () => {
      store.offerNote.mockResolvedValueOnce({ offered: false, reason: "already_offered" });
      await fn.handler(ev(CORRECTION));
      expect(store.promoteNote).toHaveBeenCalledTimes(1);
    });

    it("a promote the kill switch blocks is a quiet skip", async () => {
      store.canOffer.mockResolvedValueOnce("already_offered");
      settings.getBoolSetting.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      await fn.handler(ev(CORRECTION));
      expect(store.promoteNote).not.toHaveBeenCalled();
      expect(logs.some((l) => l.code === "team_note.skip.disabled")).toBe(true);
    });

    it("an upgraded claim is judged like a fresh one", async () => {
      store.claimJudgement.mockResolvedValueOnce("upgraded");
      await fn.handler(ev(CORRECTION));
      expect(judge.judgeWith).toHaveBeenCalledTimes(1);
      expect(store.offerNote).toHaveBeenCalledTimes(1);
    });

    it("a taken claim (no upgrade allowed) skips quietly", async () => {
      store.claimJudgement.mockResolvedValueOnce("taken");
      await fn.handler(ev(CORRECTION));
      expect(judge.judgeWith).not.toHaveBeenCalled();
      expect(store.promoteNote).not.toHaveBeenCalled();
    });
  });

  describe("judgement log (counts only)", () => {
    it("bad: recorded with the judge signal and the surface", async () => {
      await fn.handler(ev(RUN_END));
      expect(store.recordJudgement).toHaveBeenCalledWith(T, {
        messageId: "m1", source: "run_end", signals: ["tool_repeat_failure"], verdict: "bad", judgeSignal: "tool_failure", surface: "flag",
      });
    });

    it.each([
      ["no", { bad: false } as JudgeVerdict],
      ["transport", { bad: false, failed: "transport" } as JudgeVerdict],
      ["parse", { bad: false, failed: "parse" } as JudgeVerdict],
    ])("%s: recorded with no judge signal and no surface", async (code, verdict) => {
      judge.judgeWith.mockResolvedValueOnce({ verdict, usage: null });
      await fn.handler(ev(RUN_END));
      expect(store.recordJudgement).toHaveBeenCalledWith(T, expect.objectContaining({ verdict: code, judgeSignal: null, surface: null }));
      expect(store.offerNote).not.toHaveBeenCalled();
    });

    it("a failed judgement write never blocks the note", async () => {
      store.recordJudgement.mockRejectedValueOnce(new Error("db down"));
      await fn.handler(ev(RUN_END));
      expect(store.offerNote).toHaveBeenCalledTimes(1);
      expect(logs.some((l) => l.code === "team_note.judgement_record_failed")).toBe(true);
      expect(logs.some((l) => l.code === "team_note.worker_error")).toBe(false);
    });

    it("no judge call (precheck, claim, promote) means no judgement row", async () => {
      store.canOffer.mockResolvedValueOnce("already_offered");
      await fn.handler(ev(CORRECTION));
      expect(store.recordJudgement).not.toHaveBeenCalled();
    });
  });
});
