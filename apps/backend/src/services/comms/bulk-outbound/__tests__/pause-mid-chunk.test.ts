import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/tenant-client", () => ({ asTenantId: (t: string) => t, tenantClient: vi.fn(), globalClient: vi.fn(), tenantRpc: vi.fn(async () => ({ data: true, error: null })) }));
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({}) }));
vi.mock("@/services/settings", () => ({ getBoolSettingStrictResolved: vi.fn(), setTenantSetting: vi.fn() }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));
vi.mock("../thread-notice", () => ({ postBulkSendNotice: vi.fn(async () => true) }));

import { runBulkChunk } from "../fanout";
import { DECISION, FROM, LIST, TENANT, harness, people, sentTo } from "./harness";

async function frozen(h: ReturnType<typeof harness>) {
  const f = await h.ledger.freeze({ tenantId: TENANT, decisionId: DECISION, listId: LIST, versionId: h.body().list_version_id, subject: "s", bodyText: "b", fromAddress: FROM, replyTo: null, cap: 1000 });
  if (!f.ok) throw new Error("freeze");
  return f.send_id;
}

function pauseAfter(h: ReturnType<typeof harness>, n: number, flip: () => void) {
  const wire = h.deps.wire;
  let calls = 0;
  h.deps.wire = async (msg) => {
    const out = await wire(msg);
    calls += 1;
    if (calls === n) flip();
    return out;
  };
}

describe("a pause stops a batch that is already going out", () => {
  it("paused after the 3rd email of a 100-person chunk: nobody else is emailed, the send is held as paused, and resume sends the rest exactly once", async () => {
    const h = harness({ emails: people(100) });
    let paused = false;
    const reads = vi.fn(async () => paused);
    h.deps.paused = reads;
    pauseAfter(h, 3, () => {
      paused = true;
    });
    const send = await frozen(h);
    const r = await runBulkChunk({ tenantId: TENANT, sendId: send }, h.deps);
    expect(r).toMatchObject({ state: "held", counts: { hold_reason: "email_paused", sent: 3, pending: 97 } });
    expect(sentTo(h.wire)).toHaveLength(3);
    expect(reads.mock.calls.length).toBeLessThanOrEqual(5);

    paused = false;
    h.ledger.sends.get(send)!.status = "sending";
    h.ledger.sends.get(send)!.hold_reason = null;
    expect(await runBulkChunk({ tenantId: TENANT, sendId: send }, h.deps)).toMatchObject({ state: "done", counts: { sent: 100 } });
    expect(sentTo(h.wire)).toHaveLength(100);
    expect(new Set(sentTo(h.wire)).size).toBe(100);
  });

  it("the pause cannot be read partway: sending stops for this chunk, the send is not held, and the next chunk carries on", async () => {
    const h = harness({ emails: people(10) });
    let down = false;
    h.deps.paused = async () => {
      if (down) throw new Error("db");
      return false;
    };
    pauseAfter(h, 2, () => {
      down = true;
    });
    const send = await frozen(h);
    expect(await runBulkChunk({ tenantId: TENANT, sendId: send }, h.deps)).toMatchObject({ state: "more", counts: { status: "sending", sent: 2, pending: 8 } });
    down = false;
    expect(await runBulkChunk({ tenantId: TENANT, sendId: send }, h.deps)).toMatchObject({ state: "done", counts: { sent: 10 } });
    expect(new Set(sentTo(h.wire)).size).toBe(10);
  });

  it("never paused: the whole chunk goes and the pause is read once per email at most", async () => {
    const h = harness({ emails: people(20) });
    const reads = vi.fn(async () => false);
    h.deps.paused = reads;
    const send = await frozen(h);
    expect(await runBulkChunk({ tenantId: TENANT, sendId: send }, h.deps)).toMatchObject({ state: "done", counts: { sent: 20 } });
    expect(reads.mock.calls.length).toBeLessThanOrEqual(21);
  });
});
