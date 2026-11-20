import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/tenant-client", () => ({ asTenantId: (t: string) => t, tenantClient: vi.fn(), globalClient: vi.fn(), tenantRpc: vi.fn(async () => ({ data: true, error: null })) }));
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({}) }));
vi.mock("@/services/settings", () => ({ getBoolSettingStrictResolved: vi.fn(), setTenantSetting: vi.fn() }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));
vi.mock("../thread-notice", () => ({ postBulkSendNotice: vi.fn(async () => true) }));

import { runBulkChunk } from "../fanout";
import { executeBulkOutboundDispatch } from "../dispatch";
import { sendBulkEmail, type BulkWireMessage } from "../wire";
import { DECISION, TENANT, harness, people, sentTo } from "./harness";

const MSG: BulkWireMessage = { tenantId: TENANT, sendId: "s", to: "a@x.com", from: { email: "hello@acme.com" }, replyTo: null, subject: "s", bodyText: "b", unsubToken: "t", postalAddress: "1 Main St" };

describe("a SendGrid 429 is a rate limit: back off and keep sending, never a hold for staff", () => {
  it("the wire reads 429 as throttled, not as a refusal of every email", async () => {
    process.env.BULK_SENDGRID_API_KEY = "SG.test";
    expect(await sendBulkEmail(MSG, { fetch: async () => ({ status: 429 }) })).toEqual({ kind: "throttled", status: 429 });
  });

  it("a 429 midway through the first chunk: the decision is not failed, the send keeps going, and the throttled person is emailed once later", async () => {
    const h = harness({ emails: people(5) });
    h.wire
      .mockResolvedValueOnce({ kind: "sent" })
      .mockResolvedValueOnce({ kind: "throttled", status: 429 } as never)
      .mockResolvedValue({ kind: "sent" });
    const r = await executeBulkOutboundDispatch({ tenant_id: TENANT, decision_id: DECISION, approved_by: "user-a", body: h.body(), deps: h.deps });
    expect(r).toMatchObject({ ok: true, state: "more", counts: { sent: 1, pending: 4, status: "sending", hold_reason: null } });
    if (!r.ok) throw new Error("dispatch");
    expect(h.ledger.sends.get(r.send_id)!.status).toBe("sending");
    const next = await runBulkChunk({ tenantId: TENANT, sendId: r.send_id }, h.deps);
    expect(next).toMatchObject({ state: "done", counts: { sent: 5 } });
    const to = sentTo(h.wire);
    expect(to.filter((e) => e === "p0001@x.com")).toHaveLength(2);
    expect(new Set(to.slice(2))).toEqual(new Set(["p0001@x.com", "p0002@x.com", "p0003@x.com", "p0004@x.com"]));
  });

  it("a 429 on the very first email: still not a failure or a refusal, nobody is lost", async () => {
    const h = harness({ emails: people(3) });
    h.wire.mockResolvedValueOnce({ kind: "throttled", status: 429 } as never);
    const r = await executeBulkOutboundDispatch({ tenant_id: TENANT, decision_id: DECISION, approved_by: "user-a", body: h.body(), deps: h.deps });
    expect(r).toMatchObject({ ok: true, state: "more", counts: { sent: 0, pending: 3 } });
  });
});
