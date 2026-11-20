import { describe, expect, it, vi } from "vitest";
import { PINTEREST_METER_KEY, PINTEREST_READS_PER_DAY, keepStoredDetail, refreshPinterest } from "../snapshots";

const TENANT = "7c70da58-091e-4ff5-8f77-343034d448d9";
const insight = {
  fetched_at: "2026-10-16T00:00:00Z",
  window: { start_date: "2026-09-16", end_date: "2026-10-15" },
  username: "dudhat0633",
  account_type: "BUSINESS",
  website_url: null,
  follower_count: 120,
  pin_count: 40,
  board_count: 2,
  boards: [],
  boards_error: null,
  boards_complete: true,
  account_totals: { IMPRESSION: 5400, OUTBOUND_CLICK: 31, SAVE: 88 },
  account_error: null,
  top_pins: [],
  top_pins_error: null,
  provenance: "owned" as const,
  cannot_see: [],
  note: "owned",
};

const detail = {
  daily: [{ date: "2026-10-15", impressions: 200, engagements: 9, clicks: 3, saves: 2 }],
  daily_error: null,
  pins: { "30": [{ id: "p1", title: "Linen", format: "image" as const, image: "https://i.pinimg.com/150x150/a.jpg", url: "https://www.pinterest.com/pin/p1/", impressions: 900, engagements: 40, clicks: 5, saves: 9 }] },
  pins_error: null,
};

const storedToday: Record<string, unknown> = {
  eq: () => storedToday,
  maybeSingle: async () => ({ data: null, error: null }),
};

function harness(slot: number | null) {
  const upsert = vi.fn(async () => ({ error: null }));
  return {
    upsert,
    deps: {
      resolveAccount: vi.fn(async () => ({ tenant_id: TENANT, toolkit: "pinterest", connected_account_id: "ca_pin" })),
      rpc: vi.fn(async () => ({ data: slot, error: null })),
      client: { from: () => ({ upsert, select: () => storedToday }) },
      read: vi.fn(async () => insight),
      detail: vi.fn(async () => detail),
      now: () => new Date("2026-10-16T10:00:00Z"),
    },
  };
}

describe("refreshPinterest", () => {
  it("meters and stores the connected account's daily performance snapshot", async () => {
    const h = harness(1);
    expect(await refreshPinterest(TENANT, h.deps as never)).toEqual({ ok: true, used: 1, cap: PINTEREST_READS_PER_DAY });
    expect(h.deps.rpc).toHaveBeenCalledWith(TENANT, "consume_metered_read_or_reject", {
      p_day: "2026-10-16",
      p_key: PINTEREST_METER_KEY,
      p_cap: 3,
    });
    expect(h.upsert).toHaveBeenCalledWith(expect.objectContaining({
      username: "dudhat0633",
      followers_count: 120,
      post_count: 40,
      metrics: expect.objectContaining({ account_totals: insight.account_totals, daily: detail.daily, pins: detail.pins }),
    }), { onConflict: "tenant_id,channel,captured_on" });
  });

  it("still stores the account snapshot when the pin detail read fails", async () => {
    const h = harness(1);
    h.deps.detail.mockRejectedValue(new Error("Pinterest did not answer in time") as never);
    expect(await refreshPinterest(TENANT, h.deps as never)).toMatchObject({ ok: true });
    expect(h.upsert).toHaveBeenCalledWith(expect.objectContaining({
      metrics: expect.objectContaining({ account_totals: insight.account_totals, daily: null, pins: null, pins_error: "Pinterest did not answer in time" }),
    }), expect.anything());
  });

  it("does not read Pinterest after the daily cap", async () => {
    const h = harness(null);
    expect(await refreshPinterest(TENANT, h.deps as never)).toMatchObject({ ok: false, reason: "cap_reached" });
    expect(h.deps.read).not.toHaveBeenCalled();
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("does not spend a slot when Pinterest is not connected", async () => {
    const h = harness(1);
    h.deps.resolveAccount.mockResolvedValue(null as never);
    expect(await refreshPinterest(TENANT, h.deps as never)).toMatchObject({ ok: false, reason: "not_connected" });
    expect(h.deps.rpc).not.toHaveBeenCalled();
  });
});

describe("keepStoredDetail", () => {
  const failed = { daily: null, daily_error: "down", pins: null, pins_error: "down" };

  it("keeps today's good numbers when the detail read fails", () => {
    expect(keepStoredDetail(failed, { daily: detail.daily, pins: detail.pins })).toMatchObject({ daily: detail.daily, daily_error: null, pins: detail.pins, pins_error: "down" });
  });

  it("keeps the failure when nothing good is stored", () => {
    expect(keepStoredDetail(failed, null)).toEqual(failed);
  });

  it("clears the pin error once every window is covered", () => {
    const row = detail.pins["30"];
    const out = keepStoredDetail({ ...detail, pins: { "30": row }, pins_error: "partial" }, { daily: null, pins: { "7": row, "14": row } });
    expect(out.pins_error).toBeNull();
    expect(Object.keys(out.pins!).sort()).toEqual(["14", "30", "7"]);
  });
});
