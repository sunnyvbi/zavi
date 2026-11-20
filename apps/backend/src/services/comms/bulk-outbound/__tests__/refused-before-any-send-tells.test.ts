import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/tenant-client", () => ({ asTenantId: (t: string) => t, tenantClient: vi.fn(), globalClient: vi.fn(), tenantRpc: vi.fn(async () => ({ data: true, error: null })) }));
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({}) }));
vi.mock("@/services/settings", () => ({ getBoolSettingStrictResolved: vi.fn(), setTenantSetting: vi.fn() }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));
vi.mock("../thread-notice", () => ({ postBulkSendNotice: vi.fn(async () => true) }));

import { executeBulkOutboundDispatch } from "../dispatch";
import { runBulkChunk } from "../fanout";
import { bulkSendOutcome } from "@/services/email-cards/outcome";
import { rebuildSendOutcome } from "@/services/email-cards/outcome-rebuild";
import { DECISION, FROM, LIST, TENANT, harness } from "./harness";

const run = (h: ReturnType<typeof harness>) => executeBulkOutboundDispatch({ tenant_id: TENANT, decision_id: DECISION, approved_by: "user-a", body: h.body(), deps: h.deps });
const told = (r: Awaited<ReturnType<typeof run>>) => {
  if (r.ok || r.status !== "refused") throw new Error(`expected a refusal, got ${JSON.stringify(r)}`);
  return bulkSendOutcome(TENANT, DECISION, r.status, null, r.sentence, r.code);
};
const rebuild = (dispatch_error: string) =>
  rebuildSendOutcome(TENANT, { rail: "decisions", card_id: DECISION, outcome: "failed" }, {
    readDecision: async () => ({ tenant_id: TENANT, decision_class: "bulk_outbound.send", status: "dispatch_failed", dispatch_error }),
    readBulkSend: async () => null,
  });

describe("a dispatch refused for a transient reason ends the card", () => {
  it("a check that could not be read leaves no send row, so the approver is told Not sent", async () => {
    const h = harness();
    h.state.refusal = "bulk_check_failed";
    const r = await run(h);
    expect(h.ledger.sends.size).toBe(0);
    expect(h.wire).not.toHaveBeenCalled();
    expect(told(r)).toMatchObject({ outcome: "failed", sent: 0, rail: "decisions", card_id: DECISION });
  });

  it("a reply-to that could not be read is told too", async () => {
    const h = harness();
    h.deps.replyTo = async () => {
      throw new Error("db");
    };
    expect(told(await run(h))).toMatchObject({ outcome: "failed", sent: 0 });
  });

  it("the provider refusing the first chunk closes the send, and that is told as well", async () => {
    const h = harness();
    h.wire.mockResolvedValue({ kind: "stop_all", status: 401 } as never);
    const r = await run(h);
    expect([...h.ledger.sends.values()][0]).toMatchObject({ status: "failed" });
    expect(told(r)).toMatchObject({ outcome: "failed", sent: 0 });
  });

  it("the outcome is rebuilt for a retry after a lost tell, with its reason", async () => {
    expect(await rebuild("Not sent: we could not check. (bulk_check_failed)")).toMatchObject({ o: { outcome: "failed", sent: 0, reason: "Not sent: we could not check." } });
  });

  it("a card waiting on a founder's pause is still not an end", async () => {
    expect(await rebuild("Email is paused. (email_paused)")).toBeNull();
  });

  it("a check that fails on a running send stays a hold only staff can resume, and the approver is told that", async () => {
    const h = harness();
    const f = await h.ledger.freeze({ tenantId: TENANT, decisionId: DECISION, listId: LIST, versionId: h.body().list_version_id, subject: "s", bodyText: "b", fromAddress: FROM, replyTo: null, cap: 1000 });
    if (!f.ok) throw new Error("freeze");
    h.state.refusal = "bulk_check_failed";
    const c = await runBulkChunk({ tenantId: TENANT, sendId: f.send_id }, h.deps);
    if (c.state === "missing") throw new Error("missing");
    expect(c.state).toBe("held");
    expect(bulkSendOutcome(TENANT, DECISION, c.state, c.counts, "line")).toMatchObject({ outcome: "failed", reason: "line" });
  });
});
