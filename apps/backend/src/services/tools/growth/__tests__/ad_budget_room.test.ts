import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ read: vi.fn(), record: vi.fn() }));
vi.mock("@/services/decisions/ad-month-counter", () => ({ readMonthCount: h.read }));
vi.mock("@/services/agents/engine/figure-ledger", () => ({ recordFiguresFromPull: h.record }));

import { adBudgetRoomTool } from "../ad_budget_room";

const count = { budget_id: "b1", month_start: "2026-10-01", monthly_usd: 27_000, month_cap_usd: 27_000, days_left: 8, spent_usd: 20_000, creator_usd: 0, running_daily_usd: 800, pending_daily_usd: 25, projection_usd: 26_800 };
const ctx = (run_id?: string) => ({ tenant_id: "t1", run_id }) as Parameters<typeof adBudgetRoomTool.execute>[0];

beforeEach(() => {
  h.read.mockReset();
  h.record.mockReset();
});

describe("growth__ad_budget_room", () => {
  it("gives the counter's projection and the room under the cap, and records the figures as sourced", async () => {
    h.read.mockResolvedValue({ token: "x", count, view: {}, live_held_daily_usd: 25 });
    const out = await adBudgetRoomTool.execute(ctx("run-1"), {});
    expect(out).toMatchObject({ status: "read", projection_usd: 26_800, room_usd: 200, over_by_usd: 0, days_left: 8 });
    expect(h.read).toHaveBeenCalledWith("t1");
    expect(h.record).toHaveBeenCalledTimes(1);
    expect(h.record).toHaveBeenCalledWith("run-1", JSON.stringify(out), "growth__ad_budget_room");
  });

  it("over the cap: the overrun, no room", async () => {
    h.read.mockResolvedValue({ token: "x", count: { ...count, projection_usd: 28_053.62 }, view: {}, live_held_daily_usd: 0 });
    expect(await adBudgetRoomTool.execute(ctx("run-1"), {})).toMatchObject({ room_usd: 0, over_by_usd: 1_053.62 });
  });

  it("must-catch (stale read never $0): unreadable gives why and no figures", async () => {
    h.read.mockResolvedValue({ unreadable: "linkedin was last read 2026-10-15" });
    expect(await adBudgetRoomTool.execute(ctx("run-1"), {})).toEqual({ status: "unreadable", why: "linkedin was last read 2026-10-15" });
    expect(h.record).not.toHaveBeenCalled();
  });

  it("no active budget, and no run id records nothing", async () => {
    h.read.mockResolvedValue(null);
    expect(await adBudgetRoomTool.execute(ctx("run-1"), {})).toEqual({ status: "no_budget" });
    h.read.mockResolvedValue({ token: "x", count, view: {}, live_held_daily_usd: 0 });
    await adBudgetRoomTool.execute(ctx(), {});
    expect(h.record).not.toHaveBeenCalled();
  });

  it("takes no arguments: a tenant_id in the input is refused", () => {
    expect(adBudgetRoomTool.input_schema.safeParse({ tenant_id: "other" }).success).toBe(false);
  });
});
