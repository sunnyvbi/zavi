import { describe, it, expect, vi } from "vitest";

vi.mock("../../client", () => ({ inngest: { createFunction: (...a: unknown[]) => ({ args: a }) } }));
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({}) }));
vi.mock("@/services/tenant-client", () => ({ asTenantId: (t: string) => t, tenantClient: vi.fn(), globalClient: vi.fn(), tenantRpc: vi.fn(async () => ({ data: true, error: null })) }));
vi.mock("@/services/settings", () => ({ getBoolSettingStrictResolved: vi.fn(), setTenantSetting: vi.fn() }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));
vi.mock("@/services/comms/bulk-outbound/thread-notice", () => ({ postBulkSendNotice: vi.fn(async () => true) }));

import { runBulkEmailFanout, type FanoutStep } from "../bulk-email-fanout";
import { runBulkChunk, type ChunkResult } from "@/services/comms/bulk-outbound/fanout";
import { bulkSendLine, STAFF_ONLY_HOLDS } from "@/services/comms/bulk-outbound/notices";
import { DECISION, FROM, LIST, TENANT, harness, people } from "@/services/comms/bulk-outbound/__tests__/harness";
import { RESUMABLE_HOLDS as ADMIN_RESUMABLE_HOLDS } from "@/services/admin-scripts/bulk-email";
import { bulkSendOutcome, notifyEmailSendOutcome } from "@/services/email-cards/outcome";
import { rebuildSendOutcome } from "@/services/email-cards/outcome-rebuild";
import type { SendCounts } from "@/services/comms/bulk-outbound/store";

const PAUSE_MS = 5 * 60 * 1000;

async function frozen(h: ReturnType<typeof harness>) {
  const f = await h.ledger.freeze({ tenantId: TENANT, decisionId: DECISION, listId: LIST, versionId: h.body().list_version_id, subject: "s", bodyText: "b", fromAddress: FROM, replyTo: null, cap: 1000 });
  if (!f.ok) throw new Error("freeze");
  return f.send_id;
}

function run(h: ReturnType<typeof harness>, send: string) {
  const notify = vi.fn(async (_t: string, _s: string, _line: string) => true);
  const mails: Array<{ subject: string; text: string }> = [];
  const lines: string[] = [];
  const sleeps: string[] = [];
  const sendEvent = vi.fn(async () => null);
  const step: FanoutStep = {
    run: async (_id, fn) => fn(),
    sleep: async (id) => {
      sleeps.push(id);
      h.ledger.now += PAUSE_MS;
    },
    waitForEvent: async () => null,
    sendEvent,
  };
  const runChunk = vi.fn(async (tenantId: string, sendId: string) => runBulkChunk({ tenantId, sendId }, h.deps));
  const out = runBulkEmailFanout(send, step, {
    resolveSend: async () => ({ tenant_id: TENANT, status: "sending", next_run_at: null }),
    runChunk,
    notify,
    tell: async (tenantId, _sendId, state, counts, line) => {
      const o = bulkSendOutcome(tenantId, DECISION, state, counts, line);
      if (!o) return;
      await notifyEmailSendOutcome(o, {
        readCard: async () => ({ body: { variants: [{ content: { subject: "Spring sale" } }], chosen_variant: 1, list_name: "Newsletter" }, approved_by: "u1", approved_by_source: "web" }),
        claim: async (_t, _r, _id, _o, l) => (lines.push(l), true),
        release: async () => {
          throw new Error("the notice went out");
        },
        emailOf: async () => "founder@acme.test",
        ownerEmail: async () => "owner@acme.test",
        send: async (_to, subject, _html, text) => void mails.push({ subject, text }),
        startResults: async () => undefined,
      });
    },
  });
  return { out, notify, mails, lines, sleeps, sendEvent, runChunk };
}

const STAFF_LINE = "Zavi will not email them unless Zavi staff resumes this send.";

describe("a send held for staff after people were emailed", () => {
  it("abuse limit trips on the last chunk with one email unsettled: the row is swept, nobody is emailed again, and the send ends told once", async () => {
    const h = harness({ emails: people(5) });
    const send = await frozen(h);
    const settle = h.ledger.settleRecipient.bind(h.ledger);
    let n = 0;
    h.ledger.settleRecipient = async (...a) => {
      n += 1;
      if (n === 5) throw new Error("settle lost");
      return settle(...a);
    };
    h.wire.mockImplementation(async () => {
      if (n === 4) h.ledger.sends.get(send)!.complaints = 5;
      return { kind: "sent" };
    });

    const r = run(h, send);
    expect(await r.out).toEqual({ ok: true, state: "done" });

    expect(h.wire).toHaveBeenCalledTimes(5);
    expect(new Set(h.wire.mock.calls.map((c) => c[0].to)).size).toBe(5);
    expect(h.ledger.statuses(send)).toEqual({ sent: 4, unknown: 1 });
    expect(h.ledger.sends.get(send)!.status).toBe("done");
    expect(h.ledger.abuseHolds.has(TENANT)).toBe(true);
    expect(h.shutOff).toHaveBeenCalledWith(TENANT, send, "abuse_complaints");
    expect(r.notify).toHaveBeenCalledTimes(1);
    expect(r.notify.mock.calls[0][2]).toBe("Sent to 4. 1 could not be confirmed, so it was not sent again.");
    expect(r.notify.mock.calls[0][2]).not.toMatch(/not emailed/);
    expect(r.mails.map((m) => m.subject)).toEqual(["Sent: Spring sale"]);
    expect(r.sendEvent).not.toHaveBeenCalled();
  });

  it("abuse limit trips with people waiting: the approver gets the final count and who can resume it, the hold stands, and nobody more is emailed", async () => {
    const h = harness({ emails: people(150) });
    const send = await frozen(h);
    h.wire.mockImplementation(async () => {
      h.ledger.sends.get(send)!.complaints = 5;
      return { kind: "sent" };
    });

    const r = run(h, send);
    expect(await r.out).toEqual({ ok: true, state: "held" });

    expect(h.wire).toHaveBeenCalledTimes(100);
    expect(r.runChunk).toHaveBeenCalledTimes(1);
    expect(r.sendEvent).not.toHaveBeenCalled();
    expect(h.ledger.sends.get(send)).toMatchObject({ status: "held", hold_reason: "abuse_complaints" });
    expect(h.ledger.abuseHolds.has(TENANT)).toBe(true);
    const line = `Sent 100 of 150, then stopped: too many people marked this email as spam. 50 people were not emailed. ${STAFF_LINE}`;
    expect(r.notify.mock.calls.map((c) => c[2])).toEqual([line]);
    expect(r.mails).toHaveLength(1);
    expect(r.mails[0].subject).toBe("Stopped part way: Spring sale");
    expect(r.mails[0].text).toContain('stopped after 100 of 150 people on "Newsletter".');
    expect(r.mails[0].text).toContain(STAFF_LINE);
    expect(r.lines).toHaveLength(1);

    h.ledger.now += PAUSE_MS;
    expect(await runBulkChunk({ tenantId: TENANT, sendId: send }, h.deps)).toMatchObject({ state: "held" });
    expect(h.wire).toHaveBeenCalledTimes(100);
  });

  it("the provider refuses part way: the person refused goes back to waiting, the end is told once with the right counts, and the run does not go on", async () => {
    const h = harness({ emails: people(120) });
    h.deps.chunkSize = 50;
    const send = await frozen(h);
    let calls = 0;
    h.wire.mockImplementation(async () => {
      calls += 1;
      return calls === 60 ? { kind: "stop_all", status: 500 } : { kind: "sent" };
    });

    const r = run(h, send);
    expect(await r.out).toEqual({ ok: true, state: "held" });

    expect(h.wire).toHaveBeenCalledTimes(60);
    expect(r.runChunk).toHaveBeenCalledTimes(2);
    expect(h.ledger.statuses(send)).toEqual({ sent: 59, pending: 61 });
    expect(h.ledger.sends.get(send)).toMatchObject({ status: "held", hold_reason: "provider_refused" });
    expect(r.mails.map((m) => m.subject)).toEqual(["Stopped part way: Spring sale"]);
    expect(r.mails[0].text).toContain(`Sent 59 of 120, then stopped: the email provider refused to send from your domain. 61 people were not emailed. ${STAFF_LINE}`);
  });

  it("an email still in flight when the limit trips with people waiting is not called not emailed, and is reported after one more look", async () => {
    const h = harness({ emails: people(150) });
    const send = await frozen(h);
    const settle = h.ledger.settleRecipient.bind(h.ledger);
    let n = 0;
    h.ledger.settleRecipient = async (...a) => {
      n += 1;
      if (n === 100) throw new Error("settle lost");
      return settle(...a);
    };
    h.wire.mockImplementation(async () => {
      if (n === 99) h.ledger.sends.get(send)!.complaints = 5;
      return { kind: "sent" };
    });

    const r = run(h, send);
    expect(await r.out).toEqual({ ok: true, state: "held" });

    expect(h.wire).toHaveBeenCalledTimes(100);
    expect(r.runChunk).toHaveBeenCalledTimes(2);
    expect(r.sleeps).toEqual(["pause-0", "pause-1"]);
    expect(h.ledger.statuses(send)).toEqual({ sent: 99, unknown: 1, pending: 50 });
    expect(r.notify.mock.calls.map((c) => c[2])).toEqual([`Sent 99 of 150, then stopped: too many people marked this email as spam. 50 people were not emailed. ${STAFF_LINE} 1 could not be confirmed, so it was not sent again.`]);
    expect(r.mails).toHaveLength(1);
  });

  it("waits one round only: a row that will not settle still gets an end, without calling it not emailed", async () => {
    const c: SendCounts = { status: "held", hold_reason: "abuse_bounces", next_run_at: null, total: 10, sent: 9, skipped: 0, failed: 0, unknown: 0, pending: 0, sending: 1, complaints: 0, hard_bounces: 3 };
    const chunk = vi.fn(async (): Promise<ChunkResult> => ({ state: "held", counts: c }));
    const notify = vi.fn(async () => true);
    const tell = vi.fn(async () => true);
    const step: FanoutStep = { run: async (_id, fn) => fn(), sleep: async () => {}, waitForEvent: async () => null, sendEvent: async () => null };
    const out = await runBulkEmailFanout("00000000-0000-4000-8000-000000000001", step, {
      resolveSend: async () => ({ tenant_id: TENANT, status: "sending", next_run_at: null }),
      runChunk: chunk,
      notify,
      tell,
    });
    expect(out).toEqual({ ok: true, state: "held" });
    expect(chunk).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(tell).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(TENANT, expect.any(String), "Sent 9 of 10, then stopped: too many of these addresses bounced. Nobody else was waiting. 1 could not be confirmed, so it was not sent again.");
  });

  it("a founder's own stop with an email in flight is told straight away, as before", async () => {
    const c: SendCounts = { status: "held", hold_reason: "stopped", next_run_at: null, total: 10, sent: 4, skipped: 5, failed: 0, unknown: 0, pending: 0, sending: 1, complaints: 0, hard_bounces: 0 };
    const chunk = vi.fn(async (): Promise<ChunkResult> => ({ state: "held", counts: c }));
    const step: FanoutStep = { run: async (_id, fn) => fn(), sleep: async () => {}, waitForEvent: async () => null, sendEvent: async () => null };
    await runBulkEmailFanout("00000000-0000-4000-8000-000000000001", step, {
      resolveSend: async () => ({ tenant_id: TENANT, status: "sending", next_run_at: null }),
      runChunk: chunk,
      notify: async () => true,
    });
    expect(chunk).toHaveBeenCalledTimes(1);
  });
});

describe("who is told a staff hold ended", () => {
  const counts = (over: Partial<SendCounts>): SendCounts => ({ status: "held", hold_reason: null, next_run_at: null, total: 400, sent: 100, skipped: 0, failed: 0, unknown: 0, pending: 300, sending: 0, complaints: 0, hard_bounces: 0, ...over });

  it.each(["abuse_complaints", "abuse_bounces", "provider_refused", "bulk_check_failed"])("%s part way is an end for the approver, with the staff line", (hold) => {
    const c = counts({ hold_reason: hold });
    const line = bulkSendLine("held", c);
    expect(line).toContain(`300 people were not emailed. ${STAFF_LINE}`);
    expect(bulkSendOutcome(TENANT, DECISION, "held", c, line)).toMatchObject({ outcome: "failed", sent: 100, total: 400, reason: line });
  });

  it("a hold the founder resumes is not an end, and does not name staff", () => {
    const c = counts({ hold_reason: "email_paused" });
    expect(bulkSendOutcome(TENANT, DECISION, "held", c, "x")).toBeNull();
    expect(bulkSendLine("held", c)).not.toMatch(/staff/);
  });

  it.each(["stopped", "list_archived", "sending_address_not_verified", "fanout_stalled"])("%s never promises a staff resume", (hold) => {
    expect(bulkSendLine("held", counts({ hold_reason: hold }))).not.toMatch(/staff/);
  });

  it("nobody confirmed and people still waiting: told it may have gone out, and that the rest wait for staff", () => {
    const c = counts({ hold_reason: "provider_refused", sent: 0, unknown: 2, pending: 398 });
    const line = bulkSendLine("held", c);
    expect(line).toMatch(/^Not confirmed:/);
    expect(line).toContain("398 people were not emailed.");
    expect(line).toContain(STAFF_LINE);
    expect(bulkSendOutcome(TENANT, DECISION, "held", c, line)).toMatchObject({ outcome: "unknown", sent: 0 });
  });

  it("nobody left waiting makes no promise about staff", () => {
    expect(bulkSendLine("held", counts({ hold_reason: "provider_refused", pending: 0, sent: 400 }))).not.toMatch(/staff/);
  });

  it("a claim that failed is rebuilt the same way, so the queued retry can still tell it", async () => {
    const c = counts({ hold_reason: "abuse_complaints" });
    const out = await rebuildSendOutcome(TENANT, { rail: "decisions", card_id: DECISION, outcome: "failed" } as never, {
      readDecision: async () => ({ tenant_id: TENANT, decision_class: "bulk_outbound.send", status: "acted", dispatch_error: null }),
      readBulkSend: async () => ({ id: "s", tenant_id: TENANT, status: "held" }),
      counts: async () => c,
    });
    expect(out).toMatchObject({ o: { outcome: "failed", sent: 100, total: 400 } });
  });

  it("the holds that promise staff are exactly the ones the admin resume script accepts", () => {
    expect([...STAFF_ONLY_HOLDS].sort()).toEqual([...ADMIN_RESUMABLE_HOLDS].sort());
  });
});
