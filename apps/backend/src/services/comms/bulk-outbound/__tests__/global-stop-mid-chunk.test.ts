import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/tenant-client", () => ({ asTenantId: (t: string) => t, tenantClient: vi.fn(), globalClient: vi.fn(), tenantRpc: vi.fn(async () => ({ data: true, error: null })) }));
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({}) }));
vi.mock("@/services/settings", () => ({ getBoolSettingStrictResolved: vi.fn(), setTenantSetting: vi.fn() }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));
vi.mock("../thread-notice", () => ({ postBulkSendNotice: vi.fn(async () => true) }));

import { runBulkChunk } from "../fanout";
import type { GlobalBulkStop } from "../config";
import { DECISION, FROM, LIST, TENANT, harness, people, sentTo } from "./harness";

async function frozen(h: ReturnType<typeof harness>) {
  const f = await h.ledger.freeze({ tenantId: TENANT, decisionId: DECISION, listId: LIST, versionId: h.body().list_version_id, subject: "s", bodyText: "b", fromAddress: FROM, replyTo: null, cap: 1000 });
  if (!f.ok) throw new Error("freeze");
  return f.send_id;
}

function flipAfter(h: ReturnType<typeof harness>, n: number, flip: () => void) {
  const wire = h.deps.wire;
  let calls = 0;
  h.deps.wire = async (msg) => {
    const out = await wire(msg);
    calls += 1;
    if (calls === n) flip();
    return out;
  };
}

describe("the global stop halts a chunk that is already going out", () => {
  it("staff stop Zavi's sender after the 4th email of a 100-person chunk: the 5th is never sent and the send is held for the global stop", async () => {
    const h = harness({ emails: people(100) });
    let stop: GlobalBulkStop = "running";
    const reads = vi.fn(async () => stop);
    h.deps.globalStop = reads;
    flipAfter(h, 4, () => {
      stop = "stopped";
    });
    const send = await frozen(h);
    const r = await runBulkChunk({ tenantId: TENANT, sendId: send }, h.deps);
    expect(r).toMatchObject({ state: "held", counts: { hold_reason: "bulk_sending_paused", sent: 4, pending: 96 } });
    expect(sentTo(h.wire)).toHaveLength(4);
    expect(reads.mock.calls.length).toBe(5);
  });

  it("a stop that lands while skipped contacts are processed still stops the next email: the read sits right before each provider call", async () => {
    const h = harness({ emails: people(10) });
    h.ledger.block(TENANT, "p0001@x.com");
    let stop: GlobalBulkStop = "running";
    let reads = 0;
    h.deps.globalStop = async () => {
      reads += 1;
      return stop;
    };
    const token = h.deps.unsubToken;
    h.deps.unsubToken = async (t, email) => {
      if (email === "p0002@x.com") stop = "stopped";
      return token(t, email);
    };
    const send = await frozen(h);
    const r = await runBulkChunk({ tenantId: TENANT, sendId: send }, h.deps);
    expect(r).toMatchObject({ state: "held", counts: { hold_reason: "bulk_sending_paused", sent: 1 } });
    expect(sentTo(h.wire)).toEqual(["p0000@x.com"]);
    expect(reads).toBe(2);
    expect((r as { counts: { pending: number } }).counts.pending).toBe(8);
  });

  it("a stop that lands while the first contacts are skipped stops the very first email of the chunk", async () => {
    const h = harness({ emails: people(5) });
    h.ledger.block(TENANT, "p0000@x.com");
    let stop: GlobalBulkStop = "running";
    h.deps.globalStop = async () => stop;
    const token = h.deps.unsubToken;
    h.deps.unsubToken = async (t, email) => {
      if (email === "p0001@x.com") stop = "stopped";
      return token(t, email);
    };
    const send = await frozen(h);
    const r = await runBulkChunk({ tenantId: TENANT, sendId: send }, h.deps);
    expect(r).toMatchObject({ state: "held", counts: { hold_reason: "bulk_sending_paused", sent: 0, pending: 4 } });
    expect(sentTo(h.wire)).toEqual([]);
  });

  it("if the claimed person cannot be put back, nothing else is written to their row (no guess) and nobody is emailed", async () => {
    const h = harness({ emails: people(3) });
    h.deps.globalStop = async () => "stopped";
    h.ledger.requeueClaimed = async () => {
      throw new Error("db");
    };
    const settle = vi.spyOn(h.ledger, "settleRecipient");
    const requeue = vi.spyOn(h.ledger, "requeueClaimed");
    const send = await frozen(h);
    const r = await runBulkChunk({ tenantId: TENANT, sendId: send }, h.deps);
    expect(r).toMatchObject({ state: "held", counts: { hold_reason: "bulk_sending_paused", sent: 0, failed: 0, sending: 1, pending: 2 } });
    expect(settle).not.toHaveBeenCalled();
    expect(requeue).toHaveBeenCalledTimes(1);
    expect(sentTo(h.wire)).toEqual([]);
  });

  it("the stop cannot be read partway: nobody else is emailed in this chunk and the send is left for the next chunk's readiness check", async () => {
    const h = harness({ emails: people(10) });
    let down = false;
    h.deps.globalStop = async () => {
      if (down) throw new Error("db");
      return "running";
    };
    flipAfter(h, 2, () => {
      down = true;
    });
    const send = await frozen(h);
    expect(await runBulkChunk({ tenantId: TENANT, sendId: send }, h.deps)).toMatchObject({ state: "more", counts: { status: "sending", sent: 2, pending: 8 } });
    expect(sentTo(h.wire)).toHaveLength(2);
    down = false;
    expect(await runBulkChunk({ tenantId: TENANT, sendId: send }, h.deps)).toMatchObject({ state: "done", counts: { sent: 10 } });
    expect(new Set(sentTo(h.wire)).size).toBe(10);
  });

  it("an unreadable answer (not a thrown read) is treated the same: sending stops for this chunk", async () => {
    const h = harness({ emails: people(10) });
    let stop: GlobalBulkStop = "running";
    h.deps.globalStop = async () => stop;
    flipAfter(h, 1, () => {
      stop = "unreadable";
    });
    const send = await frozen(h);
    expect(await runBulkChunk({ tenantId: TENANT, sendId: send }, h.deps)).toMatchObject({ state: "more", counts: { sent: 1, pending: 9 } });
    expect(sentTo(h.wire)).toHaveLength(1);
  });
});
