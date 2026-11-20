import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ logEvent: vi.fn(async (..._a: unknown[]) => {}) }));

vi.mock("@/services/tenant-client", () => ({ asTenantId: (t: string) => t, tenantClient: vi.fn(), globalClient: vi.fn(), tenantRpc: vi.fn(async () => ({ data: true, error: null })) }));
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({}) }));
vi.mock("@/services/settings", () => ({ getBoolSettingStrictResolved: vi.fn(), setTenantSetting: vi.fn() }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: mocks.logEvent }));
vi.mock("../thread-notice", () => ({ postBulkSendNotice: vi.fn(async () => true) }));

import { BULK_CHUNK_SIZE, abuseReason, nextSendingDay, runBulkChunk } from "../fanout";
import { daysToFinish } from "../guard";
import { bulkSendLine } from "../notices";
import { executeBulkOutboundDispatch } from "../dispatch";
import { BODY, DECISION, FROM, LIST, SUBJECT, TENANT, harness, people, sentTo } from "./harness";

type H = ReturnType<typeof harness>;
const DAY = 24 * 60 * 60 * 1000;
const env = { net: process.env.PRAXIS_COMMS_SAFETY_NET, cap: process.env.PRAXIS_DAILY_EMAIL_CAP };

async function start(h: ReturnType<typeof harness>) {
  const r = await executeBulkOutboundDispatch({ tenant_id: TENANT, decision_id: DECISION, approved_by: "user-a", body: h.body(), deps: h.deps });
  if (!r.ok) throw new Error(`dispatch refused: ${r.code}`);
  return r;
}
const chunk = (h: ReturnType<typeof harness>, sendId: string) => runBulkChunk({ tenantId: TENANT, sendId }, h.deps);
function countsOf(r: Awaited<ReturnType<typeof runBulkChunk>>) {
  if (r.state === "missing") throw new Error("send not found");
  return r.counts;
}

beforeEach(() => {
  mocks.logEvent.mockClear();
  delete process.env.PRAXIS_COMMS_SAFETY_NET;
  delete process.env.PRAXIS_DAILY_EMAIL_CAP;
});
afterEach(() => {
  for (const [k, v] of [["PRAXIS_COMMS_SAFETY_NET", env.net], ["PRAXIS_DAILY_EMAIL_CAP", env.cap]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("never twice", () => {
  it("running the fan-out again after it finished emails nobody", async () => {
    const h = harness({ emails: people(250) });
    const r = await start(h);
    expect((await chunk(h, r.send_id)).state).toBe("more");
    const last = await chunk(h, r.send_id);
    expect(last).toMatchObject({ state: "done" });
    await chunk(h, r.send_id);
    await chunk(h, r.send_id);
    const to = sentTo(h.wire);
    expect(to).toHaveLength(250);
    expect(new Set(to).size).toBe(250);
  });

  it("two runners over the same send never email the same person", async () => {
    const h = harness({ emails: people(180) });
    h.deps.chunkSize = 1000;
    const frozen = await h.ledger.freeze({ tenantId: TENANT, decisionId: DECISION, listId: LIST, versionId: h.body().list_version_id, subject: "s", bodyText: "b", fromAddress: FROM, replyTo: null, cap: 1000 });
    if (!frozen.ok) throw new Error("freeze");
    await Promise.all([chunk(h, frozen.send_id), chunk(h, frozen.send_id), chunk(h, frozen.send_id)]);
    const to = sentTo(h.wire);
    expect(to).toHaveLength(180);
    expect(new Set(to).size).toBe(180);
  });

  it("a crash after the claim leaves the row unknown: it is shown and never retried", async () => {
    const h = harness();
    const frozen = await h.ledger.freeze({ tenantId: TENANT, decisionId: DECISION, listId: LIST, versionId: h.body().list_version_id, subject: "s", bodyText: "b", fromAddress: FROM, replyTo: null, cap: 1000 });
    if (!frozen.ok) throw new Error("freeze");
    const b = h.ledger.rows(frozen.send_id).find((r) => r.email === "b@x.com")!;
    b.status = "sending";
    b.stamped_at = h.ledger.now - 10 * 60 * 1000;

    const r = await chunk(h, frozen.send_id);
    expect(sentTo(h.wire)).toEqual(["a@x.com", "c@x.com"]);
    expect(r).toMatchObject({ state: "done", counts: { sent: 2, unknown: 1, pending: 0 } });
    expect(bulkSendLine("done", countsOf(r))).toBe(
      "Sent to 2. 1 could not be confirmed, so it was not sent again.",
    );
    await chunk(h, frozen.send_id);
    expect(h.wire).toHaveBeenCalledTimes(2);
  });

  it("a crashed claim is counted as could-not-confirm even when the next chunk holds or finds the send already stopped", async () => {
    const holds: Array<[string, (h: H, sendId: string) => void, string]> = [
      ["the list was archived", (h) => h.ledger.archivedLists.add(LIST), "list_archived"],
      ["the sending address changed", (h) => { h.state.from = "news@other.com"; }, "sending_domain_changed"],
      ["email is paused", (h) => { h.deps.paused = async () => true; }, "email_paused"],
      ["the founder stopped it", (h, sendId) => { const s = h.ledger.sends.get(sendId)!; s.status = "held"; s.hold_reason = "stopped"; }, "stopped"],
    ];
    for (const [, makeHold, reason] of holds) {
      const h = harness();
      const frozen = await h.ledger.freeze({ tenantId: TENANT, decisionId: DECISION, listId: LIST, versionId: h.body().list_version_id, subject: "s", bodyText: "b", fromAddress: FROM, replyTo: null, cap: 1000 });
      if (!frozen.ok) throw new Error("freeze");
      const b = h.ledger.rows(frozen.send_id).find((r) => r.email === "b@x.com")!;
      b.status = "sending";
      b.stamped_at = h.ledger.now - 10 * 60 * 1000;
      makeHold(h, frozen.send_id);

      const r = await chunk(h, frozen.send_id);
      expect(r).toMatchObject({ state: "held", counts: { hold_reason: reason, unknown: 1, sending: 0, sent: 0 } });
      expect(h.ledger.statuses(frozen.send_id)).toEqual({ unknown: 1, pending: 2 });
      expect(h.wire).not.toHaveBeenCalled();
    }
  });

  it("a row another attempt is still sending is left alone, and the send is not called done yet", async () => {
    const h = harness();
    const frozen = await h.ledger.freeze({ tenantId: TENANT, decisionId: DECISION, listId: LIST, versionId: h.body().list_version_id, subject: "s", bodyText: "b", fromAddress: FROM, replyTo: null, cap: 1000 });
    if (!frozen.ok) throw new Error("freeze");
    const b = h.ledger.rows(frozen.send_id).find((r) => r.email === "b@x.com")!;
    b.status = "sending";
    b.stamped_at = h.ledger.now - 5 * 1000;
    const r = await chunk(h, frozen.send_id);
    expect(r).toMatchObject({ state: "more", counts: { sent: 2, sending: 1 } });
    expect(sentTo(h.wire)).not.toContain("b@x.com");
  });

  it("a timeout or a thrown wire call is unknown; a definite refusal is failed; neither is retried", async () => {
    const h = harness();
    h.wire
      .mockResolvedValueOnce({ kind: "unknown" })
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce({ kind: "rejected", status: 400 });
    const r = await executeBulkOutboundDispatch({ tenant_id: TENANT, decision_id: DECISION, approved_by: "user-a", body: h.body(), deps: h.deps });
    expect(r).toMatchObject({ ok: false, status: "unconfirmed", code: "bulk_outbound_unconfirmed", state: "done", counts: { sent: 0, unknown: 2, failed: 1 } });
    expect(!r.ok && r.sentence).toMatch(/may have gone out/);
    expect(!r.ok && r.sentence).not.toMatch(/Not sent|nobody was emailed/i);
    const sendId = [...h.ledger.sends.keys()][0];
    expect(h.ledger.statuses(sendId)).toEqual({ unknown: 2, failed: 1 });
    await chunk(h, sendId);
    expect(h.wire).toHaveBeenCalledTimes(3);
  });

  it("a 403 from the provider means the domain is no longer authenticated: un-verify it and hold", async () => {
    const h = harness({ emails: people(10) });
    h.wire.mockResolvedValueOnce({ kind: "sent" }).mockResolvedValueOnce({ kind: "stop_all", status: 403 });
    const r = await executeBulkOutboundDispatch({ tenant_id: TENANT, decision_id: DECISION, approved_by: "user-a", body: h.body(), deps: h.deps });
    expect(h.unverifyDomain).toHaveBeenCalledWith(TENANT);
    expect(r).toMatchObject({ ok: true, state: "held", counts: { hold_reason: "sending_address_not_verified", sent: 1 } });
    expect(h.wire).toHaveBeenCalledTimes(2);
  });

  it("an error that will hit every email stops the batch, holds the send, and puts the refused person back to waiting", async () => {
    const h = harness({ emails: people(40) });
    h.wire.mockResolvedValueOnce({ kind: "sent" }).mockResolvedValueOnce({ kind: "stop_all", status: 401 });
    const r = await executeBulkOutboundDispatch({ tenant_id: TENANT, decision_id: DECISION, approved_by: "user-a", body: h.body(), deps: h.deps });
    expect(h.wire).toHaveBeenCalledTimes(2);
    expect(h.unverifyDomain).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, state: "held", counts: { sent: 1, failed: 0, pending: 39, hold_reason: "provider_refused" } });
    expect(r.ok && r.line).toBe("Sent 1 of 40, then stopped: the email provider refused to send from your domain. 39 people were not emailed. Zavi will not email them unless Zavi staff resumes this send.");
    const refused = h.ledger.rows(r.ok ? r.send_id : "").find((x) => x.email === "p0001@x.com")!;
    expect(refused.status).toBe("pending");
  });

  it("a person put back to waiting who unsubscribes meanwhile is skipped when the send resumes", async () => {
    const h = harness({ emails: people(3) });
    h.wire.mockResolvedValueOnce({ kind: "sent" }).mockResolvedValueOnce({ kind: "stop_all", status: 401 });
    const r = await executeBulkOutboundDispatch({ tenant_id: TENANT, decision_id: DECISION, approved_by: "user-a", body: h.body(), deps: h.deps });
    if (!r.ok) throw new Error("dispatch");
    expect(h.ledger.rows(r.send_id).find((x) => x.email === "p0001@x.com")!.status).toBe("pending");
    h.ledger.block(TENANT, "p0001@x.com", "unsubscribed");
    h.ledger.sends.get(r.send_id)!.status = "sending";
    h.wire.mockResolvedValue({ kind: "sent" });
    const next = await chunk(h, r.send_id);
    expect(sentTo(h.wire).filter((e) => e === "p0001@x.com")).toHaveLength(1);
    expect(next).toMatchObject({ state: "done", counts: { sent: 2, skipped: 1 } });
  });

  it("nobody is claimed from a list archived (or whose consent is gone) partway through a chunk", async () => {
    const h = harness({ emails: people(10) });
    h.wire.mockImplementation(async (msg) => {
      if (msg.to === "p0002@x.com") h.ledger.archivedLists.add(LIST);
      return { kind: "sent" };
    });
    const r = await start(h);
    expect(sentTo(h.wire)).toEqual(["p0000@x.com", "p0001@x.com", "p0002@x.com"]);
    expect(r.counts.pending).toBe(7);
  });

  it("an unknown outcome is never put back to waiting", async () => {
    const h = harness({ emails: people(3) });
    h.wire.mockResolvedValueOnce({ kind: "unknown" }).mockResolvedValueOnce({ kind: "stop_all", status: 401 });
    const r = await executeBulkOutboundDispatch({ tenant_id: TENANT, decision_id: DECISION, approved_by: "user-a", body: h.body(), deps: h.deps });
    expect(r).toMatchObject({ ok: false, status: "unconfirmed", code: "provider_refused", state: "held", counts: { sent: 0, unknown: 1 } });
    expect(!r.ok && r.sentence).toMatch(/^Not confirmed:/);
    expect(h.ledger.statuses([...h.ledger.sends.keys()][0])).toEqual({ unknown: 1, pending: 2 });
  });
});

describe("a person blocked between the claim and the wire call is not emailed", () => {
  it.each([
    ["unsubscribed", (h: H, email: string): void => h.ledger.block(TENANT, email, "unsubscribed")],
    ["erased", (h: H, email: string): void => h.ledger.erase(TENANT, `c:${email}`)],
  ] as const)("%s after the claim: skipped, never sent", async (_name, block) => {
    const h = harness();
    const realClaim = h.ledger.claimNext.bind(h.ledger);
    vi.spyOn(h.ledger, "claimNext").mockImplementation(async (t, s, cap) => {
      const c = await realClaim(t, s, cap);
      if (c.outcome === "claimed" && c.email === "b@x.com") block(h, c.email);
      return c;
    });
    const r = await start(h);
    expect(sentTo(h.wire)).toEqual(["a@x.com", "c@x.com"]);
    expect(r.counts).toMatchObject({ sent: 2, skipped: 1, sending: 0 });
  });

  it("if the last check cannot be read, the person is not emailed", async () => {
    const h = harness();
    vi.spyOn(h.ledger, "skipIfBlocked").mockRejectedValueOnce(new Error("db down"));
    const r = await start(h);
    expect(sentTo(h.wire)).toEqual([]);
    expect(r).toMatchObject({ state: "more", counts: { sent: 0, failed: 0, pending: 3, sending: 0 } });
    const next = countsOf(await chunk(h, r.send_id));
    expect(sentTo(h.wire)).toEqual(["a@x.com", "b@x.com", "c@x.com"]);
    expect(next).toMatchObject({ sent: 3, failed: 0 });
  });

  it("an erase that lands while the email is on the wire is recorded as sent, not skipped", async () => {
    const h = harness({ emails: ["a@x.com"] });
    h.wire.mockImplementationOnce(async () => {
      h.ledger.erase(TENANT, "c:a@x.com");
      return { kind: "sent" };
    });
    const r = await start(h);
    expect(r.counts).toMatchObject({ sent: 1, skipped: 0 });
  });
});

describe("new-domain ramp (the allowance is computed in the ledger, not passed in)", () => {
  it("a day whose only claim was skipped by the last check, or refused by the provider, does not advance the warm-up", async () => {
    const skippedAtLastCheck = harness({ emails: ["a@x.com"], newDomain: true });
    vi.spyOn(skippedAtLastCheck.ledger, "skipIfBlocked").mockResolvedValueOnce("unsubscribed");
    await start(skippedAtLastCheck);
    expect(skippedAtLastCheck.ledger.warmup.has(`${TENANT}|acme.com`)).toBe(false);

    const refused = harness({ emails: ["a@x.com"], newDomain: true });
    refused.wire.mockResolvedValueOnce({ kind: "rejected", status: 400 });
    await executeBulkOutboundDispatch({ tenant_id: TENANT, decision_id: DECISION, approved_by: "user-a", body: refused.body(), deps: refused.deps });
    expect(refused.ledger.warmup.has(`${TENANT}|acme.com`)).toBe(false);

    const sent = harness({ emails: ["a@x.com"], newDomain: true });
    await start(sent);
    expect(sent.ledger.warmup.get(`${TENANT}|acme.com`)).toMatchObject({ index: 0 });
  });

  it("the unsubscribe token is made before the last check, so that check is the last step before sending", async () => {
    const h = harness({ emails: ["a@x.com"] });
    const order: string[] = [];
    const realSkip = h.ledger.skipIfBlocked.bind(h.ledger);
    vi.spyOn(h.ledger, "skipIfBlocked").mockImplementation(async (...a) => {
      order.push("last-check");
      return realSkip(...a);
    });
    h.deps.unsubToken = async () => {
      order.push("token");
      return "tok";
    };
    h.wire.mockImplementation(async () => {
      order.push("wire");
      return { kind: "sent" };
    });
    await start(h);
    expect(order).toEqual(["token", "last-check", "wire"]);
  });

  it("a day where everyone was skipped does not advance the warm-up", async () => {
    const h = harness({ emails: people(120), newDomain: true });
    for (const e of people(120)) h.ledger.block(TENANT, e);
    const first = await executeBulkOutboundDispatch({ tenant_id: TENANT, decision_id: DECISION, approved_by: "user-a", body: h.body(), deps: h.deps });
    expect(first).toMatchObject({ ok: false, status: "failed", code: "bulk_outbound_nobody_sent" });
    expect(h.ledger.statuses([...h.ledger.sends.keys()][0])).toEqual({ skipped: 120 });
    expect(h.ledger.warmup.has(`${TENANT}|acme.com`)).toBe(false);
  });

  it("day 0, 120 people: 50 go out, 70 wait, and the rest go the next day with no repeats", async () => {
    const h = harness({ emails: people(120), newDomain: true });
    const r = await start(h);
    expect(r.state).toBe("waiting_for_tomorrow");
    expect(r.counts).toMatchObject({ sent: 50, pending: 70, status: "waiting_for_tomorrow" });
    expect(r.line).toMatch(/^Sent 50 of 120\. The rest go out over the next day\./);
    expect(r.counts.next_run_at).toBe(nextSendingDay(new Date(h.ledger.now)));

    expect((await chunk(h, r.send_id)).state).toBe("waiting_for_tomorrow");
    expect(h.wire).toHaveBeenCalledTimes(50);

    h.ledger.now += DAY;
    const next = await chunk(h, r.send_id);
    expect(next).toMatchObject({ state: "done", counts: { sent: 120, pending: 0 } });
    const to = sentTo(h.wire);
    expect(to).toHaveLength(120);
    expect(new Set(to).size).toBe(120);
  });

  it("PRAXIS_COMMS_SAFETY_NET=0 does not raise the 50", async () => {
    process.env.PRAXIS_COMMS_SAFETY_NET = "0";
    const h = harness({ emails: people(120), newDomain: true });
    const r = await start(h);
    expect(r.counts.sent).toBe(50);
    expect(h.wire).toHaveBeenCalledTimes(50);
  });

  it("a daily cap of 0 means no daily cap configured, never no warm-up; a negative cap is refused", async () => {
    const h = harness({ emails: people(60), newDomain: true });
    const frozen = await h.ledger.freeze({ tenantId: TENANT, decisionId: DECISION, listId: LIST, versionId: h.body().list_version_id, subject: "s", bodyText: "b", fromAddress: FROM, replyTo: null, cap: 1000 });
    if (!frozen.ok) throw new Error("freeze");
    let claimed = 0;
    for (let i = 0; i < 60; i += 1) {
      const c = await h.ledger.claimNext(TENANT, frozen.send_id, 0);
      if (c.outcome !== "claimed") {
        expect(c.outcome).toBe("allowance_exhausted");
        break;
      }
      claimed += 1;
    }
    expect(claimed).toBe(50);
    await expect(h.ledger.claimNext(TENANT, frozen.send_id, -1)).rejects.toThrow();
  });

  it("a configured daily cap lowers the allowance further", async () => {
    process.env.PRAXIS_DAILY_EMAIL_CAP = "30";
    const h = harness({ emails: people(60), newDomain: true });
    const r = await start(h);
    expect(r.counts.sent).toBe(30);
  });

  it("the thread blames the new domain's warm-up only when the warm-up is what held the rest back", async () => {
    const warm = await start(harness({ emails: people(120), newDomain: true }));
    expect(warm.line).toMatch(/^Sent 50 of 120\. The rest go out over the next day\. A new sending domain starts slowly so inboxes learn to trust it\. Zavi keeps sending by itself\./);

    process.env.PRAXIS_DAILY_EMAIL_CAP = "30";
    const graduated = harness({ emails: people(100) });
    graduated.deps.chunkSize = 1000;
    const capped = await start(graduated);
    expect(capped.state).toBe("waiting_for_tomorrow");
    expect(capped.counts.sent).toBe(30);
    expect(capped.line).toMatch(/^Sent 30 of 100\. The rest go out over the next 3 days\. Zavi sends only a set number of emails each day\. Zavi keeps sending by itself\./);
    expect(capped.line).not.toMatch(/domain/);

    const tighter = await start(harness({ emails: people(120), newDomain: true }));
    expect(tighter.counts.sent).toBe(30);
    expect(tighter.line).not.toMatch(/domain/);
  });

  it("a graduated domain has no warm-up limit", async () => {
    const h = harness({ emails: people(250) });
    h.deps.chunkSize = 1000;
    expect((await start(h)).counts.sent).toBe(250);
  });

  it("estimates the days left from the warm-up curve", () => {
    expect(daysToFinish(70, 0)).toBe(1);
    expect(daysToFinish(950, 0)).toBe(4);
    expect(daysToFinish(5000, 9)).toBe(1);
  });

  it("counts every day left when a small daily cap makes the tail longer than 60 days", () => {
    process.env.PRAXIS_DAILY_EMAIL_CAP = "10";
    expect(daysToFinish(1000, 20)).toBe(100);
    expect(daysToFinish(995, 20)).toBe(100);
    process.env.PRAXIS_DAILY_EMAIL_CAP = "1";
    expect(daysToFinish(1000, 20)).toBe(1000);
  });
});

describe("mid-send holds", () => {
  it.each([
    ["the list is archived", (h: H): void => void h.ledger.archivedLists.add(LIST), "list_archived"],
    ["the domain is no longer verified", (h: H): void => void (h.state.refusal = "sending_domain_not_verified"), "sending_domain_not_verified"],
    ["bulk email is switched off for the workspace", (h: H): void => void (h.state.refusal = "bulk_outbound_disabled"), "bulk_outbound_disabled"],
    ["the global stop is on", (h: H): void => void (h.state.refusal = "bulk_sending_paused"), "bulk_sending_paused"],
    ["the postal address was removed", (h: H): void => void (h.state.refusal = "postal_address_missing"), "postal_address_missing"],
    ["the sending address changed", (h: H): void => void (h.state.from = "hello@other.com"), "sending_domain_changed"],
  ] as const)("after chunk 1, when %s, the next chunk sends nothing and the send is held", async (_name, revoke, reason) => {
    const h = harness({ emails: people(250) });
    const r = await start(h);
    expect(h.wire).toHaveBeenCalledTimes(BULK_CHUNK_SIZE);
    revoke(h);
    const next = await chunk(h, r.send_id);
    expect(h.wire).toHaveBeenCalledTimes(BULK_CHUNK_SIZE);
    expect(next).toMatchObject({ state: "held", counts: { status: "held", hold_reason: reason, sent: 100, pending: 150 } });
    h.state.refusal = null;
    h.state.from = FROM;
    h.ledger.archivedLists.clear();
    expect((await chunk(h, r.send_id)).state).toBe("held");
    expect(h.wire).toHaveBeenCalledTimes(BULK_CHUNK_SIZE);
  });

  it("a sending address changed mid-send tells the founder it changed, not that the new domain is unverified", async () => {
    const h = harness({ emails: people(250) });
    const r = await start(h);
    h.state.from = "hello@other.com";
    const next = await chunk(h, r.send_id);
    if (next.state === "missing") throw new Error("missing");
    const line = bulkSendLine(next.state, next.counts);
    expect(line).toBe("Sent 100 of 250, then stopped: your sending address changed after this was approved, so ask the agent to propose it again. 150 people were not emailed.");
    expect(line).not.toMatch(/no longer verified|something stopped/);
  });

  it("a contact erased while waiting is skipped", async () => {
    const h = harness({ emails: people(150) });
    const r = await start(h);
    h.ledger.erased.add("c:p0120@x.com");
    const next = await chunk(h, r.send_id);
    expect(sentTo(h.wire)).not.toContain("p0120@x.com");
    expect(next).toMatchObject({ state: "done", counts: { sent: 149, skipped: 1 } });
  });
});

describe("abuse shutoff", () => {
  it("thresholds (Ravi 2026-10-07): 5 complaints at any volume; 0.3% complaints or 5% hard bounces from 200 sent", () => {
    expect(abuseReason({ sent: 10, complaints: 5, hard_bounces: 0 })).toBe("abuse_complaints");
    expect(abuseReason({ sent: 10, complaints: 4, hard_bounces: 0 })).toBeNull();
    expect(abuseReason({ sent: 199, complaints: 1, hard_bounces: 50 })).toBeNull();
    expect(abuseReason({ sent: 334, complaints: 1, hard_bounces: 0 })).toBeNull();
    expect(abuseReason({ sent: 300, complaints: 1, hard_bounces: 0 })).toBe("abuse_complaints");
    expect(abuseReason({ sent: 200, complaints: 0, hard_bounces: 9 })).toBeNull();
    expect(abuseReason({ sent: 200, complaints: 0, hard_bounces: 10 })).toBe("abuse_bounces");
  });

  it("complaints over the threshold hold the rest and switch bulk email off for that workspace", async () => {
    const h = harness({ emails: people(250) });
    const r = await start(h);
    h.ledger.sends.get(r.send_id)!.complaints = 5;
    const next = await chunk(h, r.send_id);
    expect(h.wire).toHaveBeenCalledTimes(100);
    expect(next).toMatchObject({ state: "held", counts: { hold_reason: "abuse_complaints", pending: 150 } });
    expect(h.shutOff).toHaveBeenCalledWith(TENANT, r.send_id, "abuse_complaints");

    h.ledger.decisions.set("55555555-5555-4555-8555-555555555555", { tenantId: TENANT, approved_by: "user-a" });
    const again = await executeBulkOutboundDispatch({
      tenant_id: TENANT, decision_id: "55555555-5555-4555-8555-555555555555", approved_by: "user-a", body: h.body(), deps: h.deps,
    });
    expect(again).toMatchObject({ ok: false, code: "bulk_abuse_hold" });
    expect(h.wire).toHaveBeenCalledTimes(100);
  });

  it("a failed shutoff is logged by code, not swallowed, and the workspace hold still stops the next send", async () => {
    const h = harness({ emails: people(250) });
    const r = await start(h);
    h.shutOff.mockRejectedValueOnce(new Error("setting write failed for p0001@x.com"));
    h.ledger.sends.get(r.send_id)!.complaints = 5;
    await chunk(h, r.send_id);
    expect(mocks.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ code: "bulk_email.shutoff_failed", tenant_id: TENANT, meta: expect.objectContaining({ bulk_send_id: r.send_id }) }),
    );
    expect(JSON.stringify(mocks.logEvent.mock.calls)).not.toContain("@x.com");
    h.ledger.decisions.set("66666666-6666-4666-8666-666666666666", { tenantId: TENANT, approved_by: "user-a" });
    const again = await executeBulkOutboundDispatch({
      tenant_id: TENANT, decision_id: "66666666-6666-4666-8666-666666666666", approved_by: "user-a", body: h.body(), deps: h.deps,
    });
    expect(again).toMatchObject({ ok: false, code: "bulk_abuse_hold" });
  });

  it("a send the webhook already held sends nothing more", async () => {
    const h = harness({ emails: people(250) });
    const r = await start(h);
    const send = h.ledger.sends.get(r.send_id)!;
    send.status = "held";
    send.hold_reason = "abuse_bounces";
    const next = await chunk(h, r.send_id);
    expect(h.wire).toHaveBeenCalledTimes(100);
    expect(next).toMatchObject({ state: "held" });
    expect(bulkSendLine("held", countsOf(next))).toBe(
      "Sent 100 of 250, then stopped: too many of these addresses bounced. 150 people were not emailed. Zavi will not email them unless Zavi staff resumes this send.",
    );
  });
});

describe("nothing personal in a log line", () => {
  it("no address, subject or body reaches console.* or logEvent across a send, a hold and a shutoff", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const { shutOffBulkEmail } = await import("../shutoff");
    const h = harness({ emails: people(130) });
    h.wire.mockResolvedValueOnce({ kind: "unknown" }).mockRejectedValueOnce(new Error("boom p0001@x.com"));
    const r = await start(h);
    h.ledger.sends.get(r.send_id)!.complaints = 5;
    await chunk(h, r.send_id);
    await shutOffBulkEmail(TENANT, r.send_id, "abuse_complaints").catch(() => {});

    const logged = JSON.stringify([...spies.flatMap((s) => s.mock.calls), ...mocks.logEvent.mock.calls]);
    expect(logged).not.toContain("@x.com");
    expect(logged).not.toContain(SUBJECT);
    expect(logged).not.toContain(BODY);
    expect(mocks.logEvent).toHaveBeenCalledWith(expect.objectContaining({ code: "bulk_email.abuse_shutoff", tenant_id: TENANT }));
    for (const s of spies) s.mockRestore();
  });
});
