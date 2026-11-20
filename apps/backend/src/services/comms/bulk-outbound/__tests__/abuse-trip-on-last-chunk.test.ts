import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/tenant-client", () => ({ asTenantId: (t: string) => t, tenantClient: vi.fn(), globalClient: vi.fn(), tenantRpc: vi.fn(async () => ({ data: true, error: null })) }));
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({}) }));
vi.mock("@/services/settings", () => ({ getBoolSettingStrictResolved: vi.fn(), setTenantSetting: vi.fn() }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));
vi.mock("../thread-notice", () => ({ postBulkSendNotice: vi.fn(async () => true) }));

import { runBulkChunk } from "../fanout";
import { bulkSendLine } from "../notices";
import { bulkSendOutcome } from "@/services/email-cards/outcome";
import { DECISION, FROM, LIST, TENANT, harness, people } from "./harness";

async function frozen(h: ReturnType<typeof harness>) {
  const f = await h.ledger.freeze({ tenantId: TENANT, decisionId: DECISION, listId: LIST, versionId: h.body().list_version_id, subject: "s", bodyText: "b", fromAddress: FROM, replyTo: null, cap: 1000 });
  if (!f.ok) throw new Error("freeze");
  return f.send_id;
}

describe("the abuse limit trips on the last chunk", () => {
  it("everyone was emailed: the send ends and the founder is told Sent, while the workspace still goes on hold and bulk email still shuts off", async () => {
    const h = harness({ emails: people(5) });
    const send = await frozen(h);
    h.wire.mockImplementation(async () => {
      h.ledger.sends.get(send)!.complaints += 1;
      return { kind: "sent" };
    });

    const r = await runBulkChunk({ tenantId: TENANT, sendId: send }, h.deps);

    expect(r).toMatchObject({ state: "done", counts: { status: "done", sent: 5, pending: 0, hold_reason: null } });
    if (r.state === "missing") throw new Error("missing");
    expect(h.ledger.abuseHolds.has(TENANT)).toBe(true);
    expect(h.shutOff).toHaveBeenCalledWith(TENANT, send, "abuse_complaints");
    expect(bulkSendOutcome(TENANT, DECISION, r.state, r.counts, bulkSendLine(r.state, r.counts))).toMatchObject({ outcome: "sent", sent: 5, total: 5 });
  });

  it("people are still waiting: the send stays held for staff, nobody more is emailed, and the founder is told where it stopped", async () => {
    const h = harness({ emails: people(150) });
    const send = await frozen(h);
    h.wire.mockImplementation(async () => {
      h.ledger.sends.get(send)!.complaints = 5;
      return { kind: "sent" };
    });

    const r = await runBulkChunk({ tenantId: TENANT, sendId: send }, h.deps);

    expect(r).toMatchObject({ state: "held", counts: { status: "held", hold_reason: "abuse_complaints", pending: 50 } });
    expect(h.wire).toHaveBeenCalledTimes(100);
    if (r.state === "missing") throw new Error("missing");
    expect(bulkSendOutcome(TENANT, DECISION, r.state, r.counts, bulkSendLine(r.state, r.counts))).toMatchObject({ outcome: "failed", sent: 100, total: 150 });
  });
});
