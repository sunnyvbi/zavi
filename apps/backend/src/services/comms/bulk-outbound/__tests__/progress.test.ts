import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ row: null as null | Record<string, unknown>, filters: [] as Array<[string, string]>, tenant: "" }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: (t: string) => {
    mocks.tenant = t;
    const b = {
      select: () => b,
      eq: (c: string, v: string) => {
        mocks.filters.push([c, v]);
        return b;
      },
      maybeSingle: async () => ({ data: mocks.row, error: null }),
    };
    return { from: () => b };
  },
}));

import { bulkSendProgress } from "../progress";

const row = (over: Record<string, unknown>) => ({
  total: 400, sent: 0, skipped: 0, failed: 0, unknown: 0, complaints: 0, hard_bounces: 0,
  status: "sending", hold_reason: null, next_run_at: null, ...over,
});

beforeEach(() => {
  mocks.filters = [];
});

describe("bulkSendProgress", () => {
  it("reads the send of that decision under the caller's tenant", async () => {
    mocks.row = row({ sent: 100 });
    const p = await bulkSendProgress("tenant-a", "dec-1");
    expect(mocks.tenant).toBe("tenant-a");
    expect(mocks.filters).toEqual([["decision_id", "dec-1"]]);
    expect(p).toMatchObject({ state: "more", line: "Sent 100 of 400 so far. The rest are going out now.", waiting: 300, in_progress: true });
  });

  it("finished, waiting for tomorrow, and held", async () => {
    mocks.row = row({ status: "done", sent: 397, skipped: 2, unknown: 1 });
    expect((await bulkSendProgress("t", "d"))?.line).toBe(
      "Sent to 397. 2 people on this list were left out because they unsubscribed or bounced. 1 could not be confirmed, so it was not sent again.",
    );
    mocks.row = row({ status: "waiting_for_tomorrow", total: 1000, sent: 50, next_run_at: "2026-10-08T00:05:00.000Z" });
    expect(await bulkSendProgress("t", "d")).toMatchObject({
      line: "Sent 50 of 1,000. Zavi sends a limited number of emails each day, fewer while a new sending domain warms up, so the rest go out over the coming days. It keeps going by itself.",
      in_progress: true,
    });
    mocks.row = row({ status: "held", sent: 100, hold_reason: "list_archived" });
    expect(await bulkSendProgress("t", "d")).toMatchObject({
      line: "Sent 100 of 400, then stopped: the contact list was archived. 300 people were not emailed.",
      in_progress: false,
    });
  });

  it("no send for that decision (refused, or another workspace's) is null", async () => {
    mocks.row = null;
    expect(await bulkSendProgress("tenant-b", "dec-1")).toBeNull();
  });
});
