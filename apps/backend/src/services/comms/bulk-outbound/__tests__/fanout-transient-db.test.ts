import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/tenant-client", () => ({ asTenantId: (t: string) => t, tenantClient: vi.fn(), globalClient: vi.fn(), tenantRpc: vi.fn(async () => ({ data: true, error: null })) }));
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({}) }));
vi.mock("@/services/settings", () => ({ getBoolSettingStrictResolved: vi.fn(), setTenantSetting: vi.fn() }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));
vi.mock("../thread-notice", () => ({ postBulkSendNotice: vi.fn(async () => true) }));

import { STALE_SENDING_SECONDS, runBulkChunk } from "../fanout";
import { executeBulkOutboundDispatch } from "../dispatch";
import { DECISION, TENANT, harness, people, sentTo } from "./harness";

type H = ReturnType<typeof harness>;

const dispatch = (h: H) => executeBulkOutboundDispatch({ tenant_id: TENANT, decision_id: DECISION, approved_by: "user-a", body: h.body(), deps: h.deps });
const rowOf = (h: H, sendId: string, email: string) => h.ledger.rows(sendId).find((r) => r.email === email)!;
const onlySend = (h: H) => [...h.ledger.sends.keys()][0]!;

function failTokenOnceFor(h: H, email: string) {
  const real = h.deps.unsubToken;
  let thrown = false;
  h.deps.unsubToken = async (t, e) => {
    if (e === email && !thrown) {
      thrown = true;
      throw new Error("supabase blip");
    }
    return real(t, e);
  };
}

function failLastCheckOnceFor(h: H, email: string) {
  const real = h.ledger.skipIfBlocked.bind(h.ledger);
  let thrown = false;
  return vi.spyOn(h.ledger, "skipIfBlocked").mockImplementation(async (t, s, contactId) => {
    if (contactId === `c:${email}` && !thrown) {
      thrown = true;
      throw new Error("supabase blip");
    }
    return real(t, s, contactId);
  });
}

describe("a database blip on the token or the last check gives the person back instead of failing them", () => {
  it("the last check throws on the only chunk: nobody is failed, nobody is emailed, the send is re-enqueued, and the next chunk emails everyone once", async () => {
    const h = harness({ emails: people(3) });
    const requeue = vi.spyOn(h.ledger, "requeueClaimed");
    const settle = vi.spyOn(h.ledger, "settleRecipient");
    failLastCheckOnceFor(h, "p0000@x.com");

    const r = await dispatch(h);

    expect(r).toMatchObject({ ok: true, state: "more", counts: { sent: 0, failed: 0, unknown: 0, sending: 0, pending: 3, status: "sending" } });
    expect(h.wire).not.toHaveBeenCalled();
    expect(requeue).toHaveBeenCalledWith(TENANT, onlySend(h), "c:p0000@x.com");
    expect(settle).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), "c:p0000@x.com", "failed");
    expect(rowOf(h, onlySend(h), "p0000@x.com").status).toBe("pending");
    expect(h.ledger.sends.get(onlySend(h))!.status).toBe("sending");

    const next = await runBulkChunk({ tenantId: TENANT, sendId: onlySend(h) }, h.deps);
    expect(next).toMatchObject({ state: "done", counts: { sent: 3, failed: 0, pending: 0 } });
    expect(sentTo(h.wire).sort()).toEqual(people(3));
  });

  it("a one-person send whose token read blips is not closed as nobody-sent: it stays sending and the retry emails them", async () => {
    const h = harness({ emails: ["solo@x.com"] });
    failTokenOnceFor(h, "solo@x.com");

    const r = await dispatch(h);

    expect(r).toMatchObject({ ok: true, state: "more", counts: { sent: 0, failed: 0, pending: 1, status: "sending" } });
    expect(h.wire).not.toHaveBeenCalled();
    const next = await runBulkChunk({ tenantId: TENANT, sendId: onlySend(h) }, h.deps);
    expect(next).toMatchObject({ state: "done", counts: { sent: 1, failed: 0 } });
    expect(sentTo(h.wire)).toEqual(["solo@x.com"]);
  });

  it("the unsubscribe token throws mid-chunk: the chunk stops there, reports more with a back-off, and the person is requeued rather than failed", async () => {
    const h = harness({ emails: people(6) });
    h.deps.chunkSize = 2;
    const first = await dispatch(h);
    expect(first).toMatchObject({ ok: true, state: "more", counts: { sent: 2, pending: 4 } });
    const sendId = onlySend(h);

    failTokenOnceFor(h, "p0003@x.com");
    const requeue = vi.spyOn(h.ledger, "requeueClaimed");
    const r = await runBulkChunk({ tenantId: TENANT, sendId }, h.deps);

    expect(r).toEqual(expect.objectContaining({ state: "more", throttled: true }));
    if (r.state === "missing") throw new Error("missing");
    expect(r.counts).toMatchObject({ sent: 3, failed: 0, unknown: 0, sending: 0, pending: 3 });
    expect(sentTo(h.wire)).toEqual(["p0000@x.com", "p0001@x.com", "p0002@x.com"]);
    expect(requeue).toHaveBeenCalledTimes(1);
    expect(requeue).toHaveBeenCalledWith(TENANT, sendId, "c:p0003@x.com");
    expect(rowOf(h, sendId, "p0003@x.com").status).toBe("pending");
    expect(rowOf(h, sendId, "p0004@x.com").status).toBe("pending");

    for (let i = 0; i < 5; i += 1) {
      const n = await runBulkChunk({ tenantId: TENANT, sendId }, h.deps);
      if (n.state !== "more") break;
    }
    const to = sentTo(h.wire);
    expect(to.slice().sort()).toEqual(people(6));
    expect(h.ledger.statuses(sendId)).toEqual({ sent: 6 });
  });

  it("someone who unsubscribed while the last check was down is never emailed: the retry finds the block", async () => {
    const h = harness({ emails: people(3) });
    const spy = failLastCheckOnceFor(h, "p0001@x.com");
    spy.mockClear();
    const real = spy.getMockImplementation()!;
    spy.mockImplementation(async (t, s, contactId) => {
      if (contactId === "c:p0001@x.com") h.ledger.block(TENANT, "p0001@x.com");
      return real(t, s, contactId);
    });

    const r = await dispatch(h);
    expect(r).toMatchObject({ ok: true, state: "more", counts: { sent: 1, failed: 0, pending: 2 } });
    const sendId = onlySend(h);
    const next = await runBulkChunk({ tenantId: TENANT, sendId }, h.deps);

    expect(next).toMatchObject({ state: "done", counts: { sent: 2, skipped: 1, failed: 0 } });
    expect(sentTo(h.wire)).not.toContain("p0001@x.com");
    expect(rowOf(h, sendId, "p0001@x.com")).toMatchObject({ status: "skipped", skip_reason: "unsubscribed" });
  });

  it("if giving the claim back also fails, the person is still not emailed and not failed, and is never emailed later", async () => {
    const h = harness({ emails: people(2) });
    failLastCheckOnceFor(h, "p0000@x.com");
    vi.spyOn(h.ledger, "requeueClaimed").mockRejectedValueOnce(new Error("still down"));

    const r = await dispatch(h);
    expect(r).toMatchObject({ ok: true, state: "more", counts: { sent: 0, failed: 0, sending: 1, pending: 1 } });
    expect(h.wire).not.toHaveBeenCalled();

    const sendId = onlySend(h);
    h.ledger.now += (STALE_SENDING_SECONDS + 1) * 1000;
    const next = await runBulkChunk({ tenantId: TENANT, sendId }, h.deps);
    expect(next).toMatchObject({ state: "done", counts: { sent: 1, unknown: 1, failed: 0 } });
    expect(sentTo(h.wire)).toEqual(["p0001@x.com"]);
  });
});
