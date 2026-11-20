import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/tenant-client", () => ({ asTenantId: (t: string) => t, tenantClient: vi.fn(), globalClient: vi.fn(), tenantRpc: vi.fn(async () => ({ data: true, error: null })) }));
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({}) }));
vi.mock("@/services/settings", () => ({ getBoolSettingStrictResolved: vi.fn(), setTenantSetting: vi.fn() }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));
vi.mock("../thread-notice", () => ({ postBulkSendNotice: vi.fn(async () => true) }));

import { runBulkChunk } from "../fanout";
import { bulkSendLine } from "../notices";
import { bulkSendOutcome } from "@/services/email-cards/outcome";
import { DECISION, FROM, LIST, TENANT, harness, people, sentTo } from "./harness";

async function frozen(h: ReturnType<typeof harness>) {
  const f = await h.ledger.freeze({ tenantId: TENANT, decisionId: DECISION, listId: LIST, versionId: h.body().list_version_id, subject: "s", bodyText: "b", fromAddress: FROM, replyTo: null, cap: 1000 });
  if (!f.ok) throw new Error("freeze");
  return f.send_id;
}

describe("the workspace email pause holds a Zavi-list send before every chunk", () => {
  it("paused: nobody is emailed, the send is held as paused, and the approver is not told it failed", async () => {
    const h = harness({ emails: people(5) });
    h.deps.paused = async () => true;
    const send = await frozen(h);
    const r = await runBulkChunk({ tenantId: TENANT, sendId: send }, h.deps);
    expect(r).toMatchObject({ state: "held", counts: { hold_reason: "email_paused", sent: 0, pending: 5 } });
    expect(h.wire).not.toHaveBeenCalled();
    if (r.state === "missing") throw new Error("missing");
    expect(bulkSendOutcome(TENANT, DECISION, "held", r.counts, bulkSendLine("held", r.counts))).toBeNull();
    expect(bulkSendLine("held", r.counts)).toContain("email is paused for this workspace");
  });

  it("paused partway: the next chunk is held, and once resumed the rest go out exactly once", async () => {
    const h = harness({ emails: people(150) });
    let paused = false;
    h.deps.paused = async () => paused;
    const send = await frozen(h);
    expect((await runBulkChunk({ tenantId: TENANT, sendId: send }, h.deps)).state).toBe("more");
    paused = true;
    expect(await runBulkChunk({ tenantId: TENANT, sendId: send }, h.deps)).toMatchObject({ state: "held", counts: { sent: 100, pending: 50 } });
    paused = false;
    h.ledger.sends.get(send)!.status = "sending";
    h.ledger.sends.get(send)!.hold_reason = null;
    expect(await runBulkChunk({ tenantId: TENANT, sendId: send }, h.deps)).toMatchObject({ state: "done", counts: { sent: 150 } });
    expect(new Set(sentTo(h.wire)).size).toBe(150);
    expect(sentTo(h.wire)).toHaveLength(150);
  });

  it("the pause cannot be read: nobody is emailed this chunk, and the send is not held", async () => {
    const h = harness({ emails: people(3) });
    h.deps.paused = async () => {
      throw new Error("db");
    };
    const send = await frozen(h);
    expect(await runBulkChunk({ tenantId: TENANT, sendId: send }, h.deps)).toMatchObject({ state: "more", counts: { status: "sending" } });
    expect(h.wire).not.toHaveBeenCalled();
  });
});
