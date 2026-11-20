import { describe, it, expect, vi } from "vitest";

vi.mock("../../client", () => ({ inngest: { createFunction: (...a: unknown[]) => ({ args: a }), send: vi.fn() } }));
vi.mock("@/services/supabase", () => ({ serviceClient: vi.fn() }));
vi.mock("@/services/comms/bulk-outbound/fanout", () => ({ defaultFanoutDeps: vi.fn(), runBulkChunk: vi.fn() }));
vi.mock("@/services/comms/bulk-outbound/thread-notice", () => ({ postBulkSendNotice: vi.fn() }));

import { runBulkEmailFanout, type FanoutStep } from "../bulk-email-fanout";
import { runEmailSendOutcomeTell } from "../email-send-outcome-tell";
import { bulkSendOutcome, keepEmailSendOutcomeLine, notifyEmailSendOutcomeOrThrow, type OutcomeDeps, type SendOutcome } from "@/services/email-cards/outcome";
import { rebuildSendOutcome } from "@/services/email-cards/outcome-rebuild";
import type { ChunkResult } from "@/services/comms/bulk-outbound/fanout";
import type { SendCounts } from "@/services/comms/bulk-outbound/store";

const SEND = "00000000-0000-4000-8000-000000000001";
const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DECISION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const counts = (over: Partial<SendCounts>): SendCounts => ({
  status: "sending", hold_reason: null, next_run_at: null, total: 250, sent: 0, skipped: 0, failed: 0, unknown: 0,
  pending: 0, sending: 0, complaints: 0, hard_bounces: 0, ...over,
});

class StepFailed extends Error {}

async function inngestReplay<T>(fn: (step: FanoutStep) => Promise<T>, retries: number) {
  const memo = new Map<string, { ok: true; value: unknown } | { ok: false; error: unknown }>();
  const attempts = new Map<string, number>();
  let executions = 0;
  for (let guard = 0; guard < 20; guard += 1) {
    executions += 1;
    let halt!: () => void;
    const halted = new Promise<null>((r) => (halt = () => r(null)));
    const step: FanoutStep = {
      run: async <R,>(id: string, body: () => Promise<R>): Promise<R> => {
        const m = memo.get(id);
        if (m) {
          if (m.ok) return m.value as R;
          throw new StepFailed(String((m.error as Error).message));
        }
        try {
          const value = await body();
          memo.set(id, { ok: true, value });
          return value;
        } catch (error) {
          const n = (attempts.get(id) ?? 0) + 1;
          attempts.set(id, n);
          if (n > retries) {
            memo.set(id, { ok: false, error });
            throw new StepFailed((error as Error).message);
          }
          halt();
          return new Promise<R>(() => undefined);
        }
      },
      sleep: async () => undefined,
      waitForEvent: async () => null,
      sendEvent: async () => null,
    };
    const out = await Promise.race([fn(step).then((value) => ({ value })), halted]);
    if (out) return { value: out.value, executions, attempts };
  }
  throw new Error("replay never finished");
}

function outcomeWorld(over: { failSends?: number; preClaimed?: boolean; noCard?: boolean } = {}) {
  const claimed = new Set<string>();
  const lines = new Set<string>();
  const delivered: Array<{ to: string; subject: string }> = [];
  const texts: string[] = [];
  const sendAttempts: string[] = [];
  let failsLeft = over.failSends ?? 0;
  const key = (rail: string, id: string, outcome: string, kind?: string) => `${rail}:${id}:${outcome}:${kind ?? ""}`;
  if (over.preClaimed) {
    claimed.add(key("decisions", DECISION, "sent"));
    lines.add(key("decisions", DECISION, "sent"));
  }
  const deps: Partial<OutcomeDeps> = {
    readCard: async (t) =>
      over.noCard || t !== TENANT ? null : { body: { variants: [{ content: { subject: "Spring sale" } }], chosen_variant: 1, list_name: "Members" }, approved_by: "u-admin", approved_by_source: null },
    claim: async (_t, rail, id, outcome, _line, kind) => {
      const k = key(rail, id, outcome, kind);
      if (claimed.has(k)) return false;
      claimed.add(k);
      if (lines.has(k)) return "reclaimed";
      lines.add(k);
      return true;
    },
    keep: async (_t, rail, id, outcome, _line, kind) => {
      const k = key(rail, id, outcome, kind);
      if (lines.has(k)) return false;
      lines.add(k);
      return true;
    },
    release: async (_t, rail, id, outcome, kind) => {
      claimed.delete(key(rail, id, outcome, kind));
    },
    emailOf: async () => "admin@northwind.test",
    ownerEmail: async () => "owner@northwind.test",
    send: async (to, subject, _html, text) => {
      sendAttempts.push(to);
      texts.push(text);
      if (failsLeft > 0) {
        failsLeft -= 1;
        throw new Error("SendGrid 503");
      }
      delivered.push({ to, subject });
    },
    startResults: async () => undefined,
  };
  return { deps, claimed, lines, delivered, sendAttempts, texts, key };
}

function fanoutDeps(w: ReturnType<typeof outcomeWorld>) {
  const runChunk = vi.fn(async (): Promise<ChunkResult> => ({ state: "done", counts: counts({ status: "done", sent: 250 }) }));
  const notify = vi.fn(async () => true);
  const tell = vi.fn(async (t: string, _s: string, state: string, c: { sent: number; total: number }, line: string) => {
    const o = bulkSendOutcome(t, DECISION, state, c, line);
    if (o) await notifyEmailSendOutcomeOrThrow(o, w.deps);
  });
  const keep = vi.fn(async (t: string, _s: string, state: string, c: { sent: number; total: number }, line: string) => {
    const o = bulkSendOutcome(t, DECISION, state, c, line);
    return o ? keepEmailSendOutcomeLine(o, w.deps) : false;
  });
  return {
    runChunk,
    notify,
    tell,
    keep,
    deps: { resolveSend: async () => ({ tenant_id: TENANT, status: "sending", next_run_at: null }), runChunk, notify, tell, keep },
  };
}

describe("the fanout's tell-outcome step retries a notice whose send failed", () => {
  it("throws on the first failed send, succeeds on the retry, and the approver gets exactly one notice; the list is never emailed again", async () => {
    const w = outcomeWorld({ failSends: 1 });
    const f = fanoutDeps(w);
    const run = await inngestReplay((step) => runBulkEmailFanout(SEND, step, f.deps), 2);
    expect(run.value).toEqual({ ok: true, state: "done" });
    expect(run.executions).toBe(2);
    expect(run.attempts.get("tell-outcome")).toBe(1);
    expect(w.sendAttempts).toEqual(["admin@northwind.test", "admin@northwind.test"]);
    expect(w.delivered).toEqual([{ to: "admin@northwind.test", subject: "Sent: Spring sale" }]);
    expect(w.claimed.has(w.key("decisions", DECISION, "sent"))).toBe(true);
    expect(f.runChunk).toHaveBeenCalledTimes(1);
    expect(f.notify).toHaveBeenCalledTimes(1);
  });

  it("a notice that never goes out stops after the retries, never fails the run, and keeps the Growth-note line", async () => {
    const w = outcomeWorld({ failSends: 99 });
    const f = fanoutDeps(w);
    const run = await inngestReplay((step) => runBulkEmailFanout(SEND, step, f.deps), 2);
    expect(run.value).toEqual({ ok: true, state: "done" });
    expect(w.sendAttempts).toHaveLength(3);
    expect(w.delivered).toEqual([]);
    expect([...w.claimed]).toEqual([]);
    expect([...w.lines]).toEqual([w.key("decisions", DECISION, "sent")]);
    expect(f.keep).toHaveBeenCalledTimes(1);
    expect(f.runChunk).toHaveBeenCalledTimes(1);
    expect(f.notify).toHaveBeenCalledTimes(1);
  });

  it("a later teller after the kept line sends the one notice nobody got, and only once", async () => {
    const w = outcomeWorld({ failSends: 3 });
    const f = fanoutDeps(w);
    await inngestReplay((step) => runBulkEmailFanout(SEND, step, f.deps), 2);
    const o = bulkSendOutcome(TENANT, DECISION, "done", { sent: 250, total: 250 }, "Sent to 250 people.")!;
    await expect(notifyEmailSendOutcomeOrThrow(o, w.deps)).resolves.toBe(true);
    await expect(notifyEmailSendOutcomeOrThrow(o, w.deps)).resolves.toBe(false);
    expect(w.sendAttempts).toHaveLength(4);
    expect(w.delivered).toEqual([{ to: "admin@northwind.test", subject: "Sent: Spring sale" }]);
  });

  it("guard: an end already told, or a card with nothing to tell, does not throw, so nothing is retried", async () => {
    for (const over of [{ preClaimed: true }, { noCard: true }]) {
      const w = outcomeWorld(over);
      const f = fanoutDeps(w);
      const run = await inngestReplay((step) => runBulkEmailFanout(SEND, step, f.deps), 2);
      expect(run.value).toEqual({ ok: true, state: "done" });
      expect(run.executions).toBe(1);
      expect(run.attempts.size).toBe(0);
      expect(f.tell).toHaveBeenCalledTimes(1);
      expect(w.delivered).toEqual([]);
    }
  });
});

describe("email-send-outcome-tell: the dispatch path's retry of a notice", () => {
  const o: SendOutcome = { tenant_id: TENANT, rail: "decisions", card_id: DECISION, outcome: "sent", sent: 3, total: 3 };
  const ref = { tenant_id: TENANT, rail: "decisions", card_id: DECISION, outcome: "sent" };
  const workerDeps = (w: ReturnType<typeof outcomeWorld>, from: SendOutcome = o) => ({
    rebuild: vi.fn(async () => ({ o: from })),
    tell: (x: SendOutcome) => notifyEmailSendOutcomeOrThrow(x, w.deps),
    keep: (x: SendOutcome) => keepEmailSendOutcomeLine(x, w.deps),
  });

  it("retries a failed send until the one notice goes out", async () => {
    const w = outcomeWorld({ failSends: 2 });
    const run = await inngestReplay((step) => runEmailSendOutcomeTell(ref, step, workerDeps(w)), 4);
    expect(run.value).toEqual({ told: true });
    expect(run.executions).toBe(3);
    expect(w.delivered).toHaveLength(1);
  });

  it("guard: an end someone else already told, or no card, is not retried", async () => {
    for (const over of [{ preClaimed: true }, { noCard: true }]) {
      const w = outcomeWorld(over);
      const run = await inngestReplay((step) => runEmailSendOutcomeTell(ref, step, workerDeps(w)), 4);
      expect(run.value).toEqual({ told: false });
      expect(run.executions).toBe(1);
      expect(w.sendAttempts).toEqual([]);
    }
  });

  it("a notice that never goes out keeps the Growth-note line after the last retry", async () => {
    const w = outcomeWorld({ failSends: 99 });
    const run = await inngestReplay((step) => runEmailSendOutcomeTell(ref, step, workerDeps(w)), 4);
    expect(run.value).toEqual({ told: false });
    expect(w.sendAttempts).toHaveLength(5);
    expect(w.delivered).toEqual([]);
    expect([...w.claimed]).toEqual([]);
    expect([...w.lines]).toEqual([w.key("decisions", DECISION, "sent")]);
    expect(run.attempts.get("keep-line")).toBeUndefined();
  });

  it("a send not settled yet is retried until it settles, then told from the settled row", async () => {
    const w = outcomeWorld();
    const d = workerDeps(w);
    d.rebuild.mockResolvedValueOnce({ pending: true } as never).mockResolvedValueOnce({ pending: true } as never);
    const run = await inngestReplay((step) => runEmailSendOutcomeTell(ref, step, d), 4);
    expect(run.value).toEqual({ told: true });
    expect(run.attempts.get("tell-outcome")).toBe(2);
    expect(w.delivered).toHaveLength(1);
  });

  it("a forged payload cannot pick the words: they come from the card's own row, read under the event's tenant", async () => {
    const w = outcomeWorld();
    const tell = vi.fn((x: SendOutcome) => notifyEmailSendOutcomeOrThrow(x, w.deps));
    const rebuild = vi.fn(async () => ({ o }));
    const forged = { ...ref, reason: "Your account was hacked, sign in at evil.test", sent: 9999 };
    const run = await inngestReplay((step) => runEmailSendOutcomeTell(forged, step, { rebuild, tell, keep: vi.fn() }), 4);
    expect(run.value).toEqual({ told: true });
    expect(rebuild).toHaveBeenCalledWith(TENANT, { rail: "decisions", card_id: DECISION, outcome: "sent" });
    expect(tell).toHaveBeenCalledWith(o);
    expect(w.texts.join("\n")).not.toMatch(/evil\.test|hacked|9999/);
  });

  const FORGED_TENANT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const rowsOf = (seen: string[]) => ({
    readDecision: async (t: string) => {
      seen.push(t);
      return t === TENANT ? { tenant_id: TENANT, decision_class: "bulk_outbound.send", status: "executed", dispatch_error: null } : null;
    },
    readBulkSend: async (t: string) => (t === TENANT ? { id: SEND, tenant_id: TENANT, status: "done" as const } : null),
    counts: async () => counts({ status: "done", sent: 250 }),
  });

  it("a tenant that is not the row's reads nothing, tells nobody and keeps no line: the read is scoped to the event's tenant", async () => {
    const seen: string[] = [];
    const w = outcomeWorld();
    const tell = vi.fn((x: SendOutcome) => notifyEmailSendOutcomeOrThrow(x, w.deps));
    const keep = vi.fn((x: SendOutcome) => keepEmailSendOutcomeLine(x, w.deps));
    const rebuild = (t: string, r: Parameters<typeof rebuildSendOutcome>[1]) => rebuildSendOutcome(t, r, rowsOf(seen));
    const run = await inngestReplay((step) => runEmailSendOutcomeTell({ ...ref, tenant_id: FORGED_TENANT }, step, { rebuild, tell, keep }), 4);
    expect(run.value).toEqual({ told: false });
    expect(seen).toEqual([FORGED_TENANT]);
    expect(tell).not.toHaveBeenCalled();
    expect(keep).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: FORGED_TENANT }));
    expect(w.sendAttempts).toEqual([]);
    expect([...w.claimed]).toEqual([]);
  });

  it("an outcome the row does not hold is never emailed", async () => {
    const w = outcomeWorld();
    const tell = vi.fn((x: SendOutcome) => notifyEmailSendOutcomeOrThrow(x, w.deps));
    const rebuild = (t: string, r: Parameters<typeof rebuildSendOutcome>[1]) => rebuildSendOutcome(t, r, rowsOf([]));
    const run = await inngestReplay((step) => runEmailSendOutcomeTell({ ...ref, outcome: "failed" }, step, { rebuild, tell, keep: vi.fn(async () => true) }), 4);
    expect(run.value).toEqual({ told: false });
    expect(tell).not.toHaveBeenCalled();
    expect(w.sendAttempts).toEqual([]);
  });

  it("a released claim whose row cannot be rebuilt any more still keeps the Growth-note line, from the reference", async () => {
    const w = outcomeWorld({ failSends: 99 });
    const first: SendOutcome = { tenant_id: TENANT, rail: "channel_actions", card_id: DECISION, outcome: "unknown", sent: null, reason: "Zavi could not check." };
    expect(await notifyEmailSendOutcomeOrThrow(first, w.deps).catch(() => "retry")).toBe("retry");
    expect([...w.claimed]).toEqual([]);
    const tell = vi.fn((x: SendOutcome) => notifyEmailSendOutcomeOrThrow(x, w.deps));
    const action = { tenant_id: TENANT, exec_class: "email_campaign.create_and_send" };
    const rebuild = (t: string, r: Parameters<typeof rebuildSendOutcome>[1]) =>
      rebuildSendOutcome(t, r, { readAction: async () => ({ ...action, exec_status: "executed", exec_result: { receipt: { line: "Sent to 3 people via Mailchimp" } } }) });
    const run = await inngestReplay(
      (step) => runEmailSendOutcomeTell({ tenant_id: TENANT, rail: "channel_actions", card_id: DECISION, outcome: "unknown" }, step, { rebuild, tell, keep: (x) => keepEmailSendOutcomeLine(x, w.deps) }),
      4,
    );
    expect(run.value).toEqual({ told: false });
    expect(tell).not.toHaveBeenCalled();
    expect([...w.claimed]).toEqual([]);
    expect([...w.lines]).toEqual([w.key("channel_actions", DECISION, "unknown")]);
  });

  it("a send that never settles still keeps the line from the reference after the last retry", async () => {
    const w = outcomeWorld();
    const rebuild = vi.fn(async () => ({ pending: true }) as const);
    const run = await inngestReplay((step) => runEmailSendOutcomeTell(ref, step, { rebuild, tell: vi.fn(), keep: (x) => keepEmailSendOutcomeLine(x, w.deps) }), 4);
    expect(run.value).toEqual({ told: false });
    expect(run.attempts.get("tell-outcome")).toBe(5);
    expect([...w.lines]).toEqual([w.key("decisions", DECISION, "sent")]);
    expect(w.sendAttempts).toEqual([]);
  });

  it("an event without an outcome, a tenant or a card id that is a uuid does nothing", async () => {
    const tell = vi.fn(async () => true);
    const rebuild = vi.fn();
    const keep = vi.fn();
    for (const data of [
      undefined,
      { tenant_id: TENANT },
      { ...ref, rail: "sms" },
      { ...ref, outcome: "maybe" },
      { ...ref, card_id: "not-a-uuid" },
      { ...ref, card_id: `${DECISION}' or 1=1` },
      { ...ref, tenant_id: undefined },
      { ...ref, tenant_id: "tenant-brightloop" },
    ]) {
      const run = await inngestReplay((step) => runEmailSendOutcomeTell(data, step, { tell, rebuild, keep }), 4);
      expect(run.value).toEqual({ told: false });
    }
    expect(rebuild).not.toHaveBeenCalled();
    expect(tell).not.toHaveBeenCalled();
    expect(keep).not.toHaveBeenCalled();
  });
});

describe("notifyEmailSendOutcomeOrThrow", () => {
  const o = { tenant_id: TENANT, rail: "decisions" as const, card_id: DECISION, outcome: "sent" as const, sent: 3, total: 3 };

  it("does not throw when the claim could not be given back, since a retry could never win it", async () => {
    const w = outcomeWorld({ failSends: 1 });
    w.deps.release = async () => {
      throw new Error("database down");
    };
    await expect(notifyEmailSendOutcomeOrThrow(o, w.deps)).resolves.toBe(false);
  });
});

describe("keepEmailSendOutcomeLine starts the email's results when it holds the line", () => {
  const base = { tenant_id: TENANT, rail: "decisions" as const, card_id: DECISION };

  it("a kept send, or a stop after some were emailed, starts results once; none emailed, or a line someone else holds, starts nothing", async () => {
    const cases: Array<[SendOutcome, boolean]> = [
      [{ ...base, outcome: "sent", sent: 3, total: 3 }, true],
      [{ ...base, outcome: "sent", sent: null }, true],
      [{ ...base, outcome: "failed", sent: 2, total: 3, reason: "stopped" }, true],
      [{ ...base, outcome: "failed", sent: 0, total: 3, reason: "refused" }, false],
      [{ ...base, outcome: "unknown", sent: 0, total: 3, reason: "unsure" }, false],
    ];
    for (const [o, starts] of cases) {
      const w = outcomeWorld();
      const startResults = vi.fn(async () => undefined);
      expect(await keepEmailSendOutcomeLine(o, { ...w.deps, startResults })).toBe(true);
      expect(startResults.mock.calls).toEqual(starts ? [[o]] : []);
      expect(await keepEmailSendOutcomeLine(o, { ...w.deps, startResults })).toBe(false);
      expect(startResults).toHaveBeenCalledTimes(starts ? 1 : 0);
    }
  });

  it("a tell that dies before its claim, then a kept line, still starts results exactly once, and a results failure never loses the line", async () => {
    const o: SendOutcome = { ...base, outcome: "sent", sent: 3, total: 3 };
    const w = outcomeWorld();
    const startResults = vi.fn(async () => {
      throw new Error("results down");
    });
    const readCard = w.deps.readCard!;
    let reads = 0;
    const flaky: Partial<OutcomeDeps> = { ...w.deps, startResults, readCard: async (...a) => (reads++ === 0 ? Promise.reject(new Error("db blip")) : readCard(...a)) };
    await expect(notifyEmailSendOutcomeOrThrow(o, flaky)).rejects.toThrow(/retry/);
    expect(startResults).not.toHaveBeenCalled();
    expect(await keepEmailSendOutcomeLine(o, flaky)).toBe(true);
    expect(startResults).toHaveBeenCalledTimes(1);
    expect(w.lines.has(w.key("decisions", DECISION, "sent"))).toBe(true);
  });
});
