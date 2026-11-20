import { describe, it, expect, vi } from "vitest";
import { alertSpendBlind, findStuckAdChanges, sweepStuckAdChanges, STUCK_AFTER_MS, type InflightChange } from "../stuck-ad-changes";

const T = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-07T12:00:00.000Z");
const old = new Date(NOW.getTime() - STUCK_AFTER_MS - 60_000).toISOString();
const recent = new Date(NOW.getTime() - 5 * 60_000).toISOString();

const change = (over: Partial<InflightChange>): InflightChange => ({
  id: "a1",
  tenant_id: T,
  exec_class: "meta_ads.update_ad_set_budget",
  exec_status: "dispatching",
  exec_claim_id: "claim-1",
  exec_claimed_at: old,
  ...over,
});

describe("findStuckAdChanges", () => {
  it("a change claimed long ago, or approved long ago and never claimed, is stuck on any channel; a fresh one is not", async () => {
    const approvedAt = vi.fn(async (_t: string, id: string) => (id === "q-old" ? old : recent));
    const out = await findStuckAdChanges(NOW, {
      inflight: async () => [
        change({ id: "d-old" }),
        change({ id: "d-new", exec_claimed_at: recent }),
        change({ id: "q-old", exec_status: "queued", exec_claim_id: null, exec_claimed_at: null }),
        change({ id: "q-new", exec_status: "queued", exec_claim_id: null, exec_claimed_at: null }),
        change({ id: "post", exec_class: "social.publish.v2" }),
        change({ id: "no-class", exec_class: null }),
      ],
      approvedAt,
    });
    expect(out.map((c) => c.id)).toEqual(["d-old", "q-old", "post"]);
  });

  it("a site pull request held in Approvals is waiting for a person, not stuck", async () => {
    const out = await findStuckAdChanges(NOW, {
      inflight: async () => [change({ id: "pr", exec_class: "github.open_site_pr", site_pr_waiting: "approvals" })],
      approvedAt: async () => old,
    });
    expect(out).toEqual([]);
  });
});

describe("sweepStuckAdChanges", () => {
  it("alerts Zavi for each stuck change and tells each tenant's founder once per sweep, with no cgo run", async () => {
    const alert = vi.fn(async () => undefined);
    const tellFounder = vi.fn(async () => undefined);
    const out = await sweepStuckAdChanges(NOW, {
      inflight: async () => [change({}), change({ id: "a2", exec_claim_id: "claim-2" }), change({ id: "b1", tenant_id: "other" })],
      approvedAt: async () => null,
      alert,
      tellFounder,
    });
    expect(out).toEqual({ stuck: 3, alerted: 3, failed: 0 });
    expect(alert).toHaveBeenCalledTimes(3);
    expect(tellFounder).toHaveBeenCalledTimes(2);
    expect(tellFounder).toHaveBeenCalledWith(T, [expect.objectContaining({ id: "a1" }), expect.objectContaining({ id: "a2" })]);
    expect(tellFounder).toHaveBeenCalledWith("other", [expect.objectContaining({ id: "b1" })]);
  });

  it("a stuck non-ad change alerts Zavi's ops only: the founder is never told", async () => {
    const alert = vi.fn(async () => undefined);
    const tellFounder = vi.fn(async () => undefined);
    const out = await sweepStuckAdChanges(NOW, {
      inflight: async () => [change({ id: "mail", exec_class: "email_campaign.create_and_send" }), change({ id: "vid", tenant_id: "other", exec_class: "generated_video.render" })],
      approvedAt: async () => null,
      alert,
      tellFounder,
    });
    expect(out).toEqual({ stuck: 2, alerted: 2, failed: 0 });
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ id: "mail" }));
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ id: "vid" }));
    expect(tellFounder).not.toHaveBeenCalled();
  });

  it("a tenant with a stuck ad change and a stuck non-ad change: both alert ops, the founder hears only the ad", async () => {
    const tellFounder = vi.fn(async () => undefined);
    await sweepStuckAdChanges(NOW, {
      inflight: async () => [change({ id: "ad" }), change({ id: "mail", exec_class: "email_campaign.create_and_send" })],
      approvedAt: async () => null,
      alert: async () => undefined,
      tellFounder,
    });
    expect(tellFounder).toHaveBeenCalledTimes(1);
    expect(tellFounder).toHaveBeenCalledWith(T, [expect.objectContaining({ id: "ad" })]);
  });

  it("one failure never stops the rest", async () => {
    const alert = vi.fn(async (c: { id: string }) => {
      if (c.id === "a1") throw new Error("outbox down");
    });
    const tellFounder = vi.fn(async () => {
      throw new Error("mail down");
    });
    const out = await sweepStuckAdChanges(NOW, {
      inflight: async () => [change({ id: "a1" }), change({ id: "a2", exec_claim_id: "claim-2" })],
      approvedAt: async () => null,
      alert,
      tellFounder,
    });
    expect(out).toEqual({ stuck: 2, alerted: 1, failed: 1 });
  });
});

describe("alertSpendBlind", () => {
  it("tells Zavi's ops at once, once per blind spell: the same last read is one alert, a new spell is a new one", async () => {
    const sent: Array<{ key: string; msg: string }> = [];
    const enqueue = async (_t: string, a: { key: string; msg: string }) => {
      sent.push(a);
    };
    let read: { budget_id: string; actual_read_at: string | null } | null = { budget_id: "b1", actual_read_at: "2026-10-07T08:00:00.000Z" };
    const lastRead = async () => read;
    expect(await alertSpendBlind("t", { lastRead, enqueue })).toEqual({ alerted: true });
    await alertSpendBlind("t", { lastRead, enqueue });
    read = { budget_id: "b1", actual_read_at: "2026-10-08T02:00:00.000Z" };
    await alertSpendBlind("t", { lastRead, enqueue });
    expect(sent.map((a) => a.key)).toEqual(["spend_blind:b1:2026-10-07T08:00:00.000Z", "spend_blind:b1:2026-10-07T08:00:00.000Z", "spend_blind:b1:2026-10-08T02:00:00.000Z"]);
    expect(sent[0].msg).toContain("last whole spend read 2026-10-07T08:00:00.000Z");
    read = null;
    expect(await alertSpendBlind("t", { lastRead, enqueue })).toEqual({ alerted: false });
  });
});
