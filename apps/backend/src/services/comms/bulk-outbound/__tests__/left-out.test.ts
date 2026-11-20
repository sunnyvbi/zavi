import { beforeEach, describe, expect, it, vi } from "vitest";

type Table = Record<string, unknown>;
const mocks = vi.hoisted(() => ({
  sends: [] as Table[],
  versions: [] as Table[],
  recipients: [] as Table[],
  sendable: null as number | null,
  rpcCalls: 0,
  failVersion: false,
  settled: null as Table | null,
}));

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({
    from: (table: string) => {
      const filters: Array<[string, unknown]> = [];
      const rows = () => {
        const all = table === "email_bulk_sends" ? mocks.sends : table === "email_list_versions" ? mocks.versions : mocks.recipients;
        return all.filter((r) => filters.every(([c, v]) => r[c] === v));
      };
      const q = {
        select: () => q,
        eq: (c: string, v: unknown) => {
          filters.push([c, v]);
          return q;
        },
        maybeSingle: async () => (table === "email_list_versions" && mocks.failVersion ? { data: null, error: { message: "down" } } : { data: rows()[0] ?? null, error: null }),
        then: (done: (v: { count: number; error: null }) => unknown) => done({ count: rows().length, error: null }),
      };
      return q;
    },
  }),
  tenantRpc: async (_t: string, name: string) => {
    if (name === "email_bulk_settle_send") return { data: mocks.settled, error: null };
    mocks.rpcCalls += 1;
    return { data: mocks.sendable, error: null };
  },
}));

import { readLeftOut } from "../left-out";
import { bulkSendProgress } from "../progress";
import { bulkSendLine } from "../notices";
import { supabaseBulkSendStore, type SendCounts } from "../store";

const send = (over: Table = {}) => ({
  id: "S1", decision_id: "D1", list_version_id: "V1", total: 3, sent: 3, skipped: 0, failed: 0, unknown: 0,
  complaints: 0, hard_bounces: 0, status: "done", hold_reason: null, next_run_at: null, ...over,
});
const blocked = (n: number, reason = "unsubscribed") =>
  Array.from({ length: n }, (_, i) => ({ send_id: "S1", contact_id: `c${reason}${i}`, status: "skipped", skip_reason: reason }));
const counts = (over: Partial<SendCounts>): SendCounts => ({
  status: "done", hold_reason: null, next_run_at: null, total: 3, sent: 3, skipped: 0, failed: 0, unknown: 0,
  pending: 0, sending: 0, complaints: 0, hard_bounces: 0, ...over,
});

beforeEach(() => {
  mocks.sends = [send()];
  mocks.versions = [{ id: "V1", contact_count: 5 }];
  mocks.recipients = [];
  mocks.sendable = null;
  mocks.rpcCalls = 0;
  mocks.failVersion = false;
});

describe("people left out of a bulk send", () => {
  it("the Testing send: 5 on the list, 2 suppressed before the freeze, total 3 and skipped 0", async () => {
    expect(await readLeftOut("t", { id: "S1" })).toBe(2);
    const p = await bulkSendProgress("t", "D1");
    expect(p?.line).toBe("Sent to 3. 2 people on this list were left out because they unsubscribed or bounced.");
    expect(p).toMatchObject({ total: 3, sent: 3, skipped: 0, waiting: 0 });
    expect(p?.line).not.toContain("skipped 0");
  });

  it("someone who unsubscribes from this email afterwards is not counted as left out", async () => {
    mocks.sendable = 2;
    expect(await readLeftOut("t", { id: "S1" })).toBe(2);
    expect(mocks.rpcCalls).toBe(0);
  });

  it("a block found at claim time adds to the ones removed at the freeze", async () => {
    mocks.sends = [send({ total: 4, sent: 3, skipped: 1 })];
    mocks.recipients = blocked(1);
    expect(await readLeftOut("t", { id: "S1" })).toBe(2);
  });

  it("a founder's stop is not an unsubscribe", async () => {
    mocks.sends = [send({ total: 4, sent: 1, skipped: 3, status: "held", hold_reason: "stopped" })];
    mocks.recipients = [...blocked(2, "stopped"), ...blocked(1, "bounced")];
    expect(await readLeftOut("t", { id: "S1" })).toBe(2);
  });

  it("over the cap, people the random 1,000 did not pick are not called unsubscribed", async () => {
    mocks.sends = [send({ total: 1000, sent: 1000 })];
    mocks.versions = [{ id: "V1", contact_count: 1500 }];
    mocks.sendable = 1500;
    expect(await readLeftOut("t", { id: "S1" })).toBe(0);
  });

  it("over the cap with blocked people, only the blocked ones are counted", async () => {
    mocks.sends = [send({ total: 1000, sent: 1000 })];
    mocks.versions = [{ id: "V1", contact_count: 1500 }];
    mocks.sendable = 1300;
    expect(await readLeftOut("t", { id: "S1" })).toBe(200);
  });

  it("a claim-time skip is not counted twice over the cap", async () => {
    mocks.sends = [send({ total: 1000, sent: 999, skipped: 1 })];
    mocks.versions = [{ id: "V1", contact_count: 1500 }];
    mocks.recipients = blocked(1);
    mocks.sendable = 1299;
    expect(await readLeftOut("t", { id: "S1" })).toBe(201);
  });

  it("over the cap with no suppression count, it names only the ledger's skips", async () => {
    mocks.sends = [send({ total: 1000, sent: 998, skipped: 2 })];
    mocks.versions = [{ id: "V1", contact_count: 1500 }];
    mocks.recipients = blocked(2);
    mocks.sendable = null;
    expect(await readLeftOut("t", { id: "S1" })).toBe(2);
  });

  it("an unread version gives no number, and the line stays true without one", async () => {
    mocks.failVersion = true;
    expect(await readLeftOut("t", { id: "S1" })).toBeNull();
    expect((await bulkSendProgress("t", "D1"))?.line).toBe("Sent to 3.");
  });

  it("nobody left out: the clause is gone", async () => {
    mocks.versions = [{ id: "V1", contact_count: 3 }];
    expect((await bulkSendProgress("t", "D1"))?.line).toBe("Sent to 3.");
  });
});

describe("the store's settled counts", () => {
  const settled = (over: Table) => ({ ok: true, status: "done", hold_reason: null, next_run_at: null, total: 3, sent: 3, skipped: 0, failed: 0, unknown: 0, pending: 0, sending: 0, complaints: 0, hard_bounces: 0, ...over });

  it("a done send carries the left-out count, and the fan-out's line reads it", async () => {
    mocks.settled = settled({});
    const c = await supabaseBulkSendStore.settleSend("t", "S1", "done");
    expect(c).toMatchObject({ total: 3, skipped: 0, left_out: 2 });
    expect(bulkSendLine("done", c)).toBe("Sent to 3. 2 people on this list were left out because they unsubscribed or bounced.");
  });

  it("a send still running does not read it", async () => {
    mocks.settled = settled({ status: "sending", sent: 1, pending: 2 });
    const c = await supabaseBulkSendStore.settleSend("t", "S1", null);
    expect(c).not.toHaveProperty("left_out");
  });

  it("an unread list falls back to the ledger and the settle still returns", async () => {
    mocks.failVersion = true;
    mocks.settled = settled({ total: 4, skipped: 1 });
    const c = await supabaseBulkSendStore.settleSend("t", "S1", "done");
    expect(bulkSendLine("done", c)).toBe("Sent to 3. 1 person on this list was left out because they unsubscribed or bounced.");
  });
});

describe("the lines that read it", () => {
  it("says one person in the singular", () => {
    expect(bulkSendLine("done", counts({ left_out: 1 }))).toBe("Sent to 3. 1 person on this list was left out because they unsubscribed or bounced.");
  });

  it("keeps failures after the left-out clause", () => {
    expect(bulkSendLine("done", counts({ sent: 2, failed: 1, left_out: 2 }))).toBe(
      "Sent to 2. 2 people on this list were left out because they unsubscribed or bounced. 1 could not be sent.",
    );
  });

  it("everyone suppressed before the freeze reads as all skipped, not as a provider refusal", () => {
    expect(bulkSendLine("done", counts({ total: 0, sent: 0, left_out: 5 }))).toBe("Not sent: everyone on the list was skipped (unsubscribed or bounced), so nobody was emailed.");
  });

  it("a refused send names the people removed before the freeze", () => {
    expect(bulkSendLine("done", counts({ sent: 0, failed: 3, left_out: 2 }))).toBe(
      "Not sent: the email provider refused 3 emails and 2 people were skipped (unsubscribed or bounced), so nobody was emailed.",
    );
  });

  it("a stopped send's people-not-emailed count ignores the left-out people", () => {
    expect(bulkSendLine("held", counts({ status: "held", hold_reason: "stopped", total: 4, sent: 1, skipped: 3, left_out: 2 }))).toBe(
      "Sent 1 of 4, then stopped: you stopped it. 3 people were not emailed.",
    );
  });

  it("a staff hold's pending count ignores them too", () => {
    expect(bulkSendLine("held", counts({ status: "held", hold_reason: "abuse_bounces", total: 4, sent: 1, pending: 3, left_out: 2 }))).toContain("3 people were not emailed.");
  });
});
