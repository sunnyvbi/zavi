import { describe, it, expect, vi } from "vitest";

vi.mock("../../client", () => ({ inngest: { createFunction: (...a: unknown[]) => ({ args: a }) } }));
vi.mock("@/services/supabase", () => ({ serviceClient: vi.fn() }));
vi.mock("@/services/comms/bulk-outbound/fanout", () => ({ defaultFanoutDeps: vi.fn(), runBulkChunk: vi.fn() }));
vi.mock("@/services/comms/bulk-outbound/thread-notice", () => ({ postBulkSendNotice: vi.fn() }));

import { runBulkEmailFanout, type FanoutStep } from "../bulk-email-fanout";
import { bulkSendOutcome, keepEmailSendOutcomeLine, notifyEmailSendOutcome, notifyEmailSendOutcomeOrThrow, type OutcomeDeps } from "@/services/email-cards/outcome";
import type { ChunkResult } from "@/services/comms/bulk-outbound/fanout";
import type { SendCounts } from "@/services/comms/bulk-outbound/store";

const SEND = "00000000-0000-4000-8000-000000000001";
const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DECISION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const step: FanoutStep = { run: async (_id, fn) => fn(), sleep: async () => {}, waitForEvent: async () => null, sendEvent: async () => null };

const counts = (over: Partial<SendCounts>): SendCounts => ({
  status: "sending", hold_reason: null, next_run_at: null, total: 400, sent: 0, skipped: 0, failed: 0, unknown: 0,
  pending: 0, sending: 0, complaints: 0, hard_bounces: 0, ...over,
});

async function stopAfter(c: SendCounts) {
  const notify = vi.fn(async (_tenantId: string, _sendId: string, _line: string) => true);
  const mails: Array<{ to: string; subject: string; html: string; text: string }> = [];
  const claimed: string[] = [];
  const tell = async (tenantId: string, _sendId: string, state: string, cs: { sent: number; total: number; hold_reason?: string | null }, line: string) => {
    const o = bulkSendOutcome(tenantId, DECISION, state, cs, line);
    if (!o) return;
    await notifyEmailSendOutcome(o, {
      readCard: async () => ({ body: { variants: [{ content: { subject: "Spring sale" } }], chosen_variant: 1, list_name: "Newsletter" }, approved_by: "u1", approved_by_source: "web" }),
      claim: async (_t, _r, _id, _o, l) => (claimed.push(l), true),
      release: async () => {
        throw new Error("release must not be called when the notice went out");
      },
      emailOf: async () => "founder@acme.test",
      ownerEmail: async () => "owner@acme.test",
      send: async (to, subject, html, text) => void mails.push({ to, subject, html, text }),
      startResults: async () => undefined,
    });
  };
  const chunks: ChunkResult[] = [{ state: "held", counts: c }];
  const out = await runBulkEmailFanout(SEND, step, {
    resolveSend: async () => ({ tenant_id: TENANT, status: "sending", next_run_at: null }),
    runChunk: async () => chunks.shift()!,
    notify,
    tell,
  });
  return { out, notify, mails, claimed };
}

describe("Stop the rest part way through a Zavi list send", () => {
  it("tells the thread and the approver how many people were never emailed, not that nobody was waiting", async () => {
    const { out, notify, mails, claimed } = await stopAfter(
      counts({ status: "held", hold_reason: "stopped", sent: 100, skipped: 300, pending: 0, sending: 0 }),
    );
    expect(out).toEqual({ ok: true, state: "held" });
    const line = "Sent 100 of 400, then stopped: you stopped it. 300 people were not emailed.";
    expect(notify).toHaveBeenCalledWith(TENANT, SEND, line);
    expect(mails).toHaveLength(1);
    const m = mails[0];
    expect(m.to).toBe("founder@acme.test");
    expect(m.subject).toBe("Stopped part way: Spring sale");
    expect(m.subject).not.toMatch(/Not sent/);
    expect(m.html).toContain("Your email <em>stopped part way</em>");
    expect(m.html).not.toContain("not sent");
    expect(m.text).toContain('Your email "Spring sale" stopped after 100 of 400 people on "Newsletter".');
    expect(m.text).toContain("300 people were not emailed.");
    for (const s of [m.text, m.html, claimed[0], ...notify.mock.calls.map((c) => String(c[2]))]) expect(s).not.toContain("Nobody else was waiting");
  });

  it("does not count failed or unconfirmed people as never emailed after a stop", async () => {
    const { notify } = await stopAfter(counts({ status: "held", hold_reason: "stopped", sent: 100, failed: 5, unknown: 2, skipped: 293 }));
    expect(notify).toHaveBeenCalledWith(TENANT, SEND, "Sent 100 of 400, then stopped: you stopped it. 293 people were not emailed. 5 could not be sent. 2 could not be confirmed, so they were not sent again.");
  });

  it("still says nobody was waiting when everyone had already been handled before the stop", async () => {
    const { notify, mails } = await stopAfter(counts({ status: "held", hold_reason: "stopped", total: 100, sent: 100 }));
    expect(notify).toHaveBeenCalledWith(TENANT, SEND, "Sent 100 of 100, then stopped: you stopped it. Nobody else was waiting.");
    expect(mails[0].subject).toBe("Stopped part way: Spring sale");
  });

  it("an approver email for a send that reached nobody still says it was not sent", async () => {
    const { mails } = await stopAfter(counts({ status: "held", hold_reason: "list_archived", sent: 0, pending: 400 }));
    expect(mails).toHaveLength(1);
    expect(mails[0].subject).toBe("Not sent: Spring sale");
    expect(mails[0].html).toContain("Your email was <em>not sent</em>");
  });
});

describe("Stop the rest when the approver's notice cannot go out", () => {
  function retrying(retries: Record<string, number>): FanoutStep & { attempts: Map<string, number> } {
    const attempts = new Map<string, number>();
    return {
      attempts,
      run: async (id, fn) => {
        let last: unknown;
        for (let i = 0; i <= (retries[id] ?? 0); i += 1) {
          attempts.set(id, (attempts.get(id) ?? 0) + 1);
          try {
            return await fn();
          } catch (e) {
            last = e;
          }
        }
        throw last;
      },
      sleep: async () => {},
      waitForEvent: async () => null,
      sendEvent: async () => null,
    };
  }

  it("each failed attempt gives its claim back, the run still ends held, and the stopped line is kept for the Growth note", async () => {
    const rows = new Map<string, string>();
    const sends: string[] = [];
    const released: string[] = [];
    const startResults = vi.fn(async () => undefined);
    const deps: Partial<OutcomeDeps> = {
      readCard: async () => ({ body: { variants: [{ content: { subject: "Spring sale" } }], chosen_variant: 1, list_name: "Newsletter" }, approved_by: "u1", approved_by_source: "web" }),
      claim: async (_t, rail, id, o, l, kind) => {
        const k = `${rail}:${id}:${o}:${kind ?? ""}`;
        if (rows.has(k)) return false;
        rows.set(k, l);
        return true;
      },
      keep: async (_t, rail, id, o, l, kind) => {
        const k = `${rail}:${id}:${o}:${kind ?? ""}`;
        if (rows.has(k)) return false;
        rows.set(k, l);
        return true;
      },
      release: async (_t, rail, id, o, kind) => {
        const k = `${rail}:${id}:${o}:${kind ?? ""}`;
        released.push(k);
        rows.delete(k);
      },
      emailOf: async () => "founder@acme.test",
      ownerEmail: async () => "owner@acme.test",
      send: async (to) => {
        sends.push(to);
        throw new Error("SendGrid 503");
      },
      startResults,
    };
    const atKeep: number[] = [];
    const notify = vi.fn(async () => true);
    const c = counts({ status: "held", hold_reason: "stopped", sent: 100, skipped: 300 });
    const s = retrying({ "tell-outcome": 2 });
    const out = await runBulkEmailFanout(SEND, s, {
      resolveSend: async () => ({ tenant_id: TENANT, status: "sending", next_run_at: null }),
      runChunk: async () => ({ state: "held", counts: c }),
      notify,
      tell: async (t, _s, state, cs, line) => {
        const o = bulkSendOutcome(t, DECISION, state, cs, line);
        if (o) await notifyEmailSendOutcomeOrThrow(o, deps);
      },
      keep: async (t, _s, state, cs, line) => {
        atKeep.push(rows.size);
        const o = bulkSendOutcome(t, DECISION, state, cs, line);
        return o ? keepEmailSendOutcomeLine(o, deps) : false;
      },
    });
    expect(out).toEqual({ ok: true, state: "held" });
    expect(s.attempts.get("tell-outcome")).toBe(3);
    expect(s.attempts.get("keep-outcome-line")).toBe(1);
    expect(sends).toEqual(["founder@acme.test", "founder@acme.test", "founder@acme.test"]);
    expect(released).toEqual([`decisions:${DECISION}:failed:`, `decisions:${DECISION}:failed:`, `decisions:${DECISION}:failed:`]);
    expect(atKeep).toEqual([0]);
    expect([...rows.keys()]).toEqual([`decisions:${DECISION}:failed:`]);
    expect([...rows.values()][0]).toMatch(/Spring sale/);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
