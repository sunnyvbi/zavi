import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({ rpc }) }));
const flag = vi.hoisted(() => ({ on: true }));
vi.mock("@/services/growth/ads-no-friction-flag", () => ({ adsNoFrictionEnabled: async () => flag.on }));
const role = vi.hoisted(() => ({ value: "owner" as string | null, throws: false }));
vi.mock("@/services/auth/tenant-role", () => ({
  loadTenantRoleFor: vi.fn(async () => {
    if (role.throws) throw new Error("down");
    return role.value;
  }),
}));

import { reserveAdSpend } from "../ad-budget";
import { loadTenantRoleFor } from "@/services/auth/tenant-role";

const args = () => rpc.mock.calls[0][1] as Record<string, unknown>;
const D = { id: "act-1", tenant_id: "tenant-1", exec_source: "channel_actions" };

beforeEach(() => {
  rpc.mockReset();
  rpc.mockResolvedValue({ data: { status: "held", amount_usd: 58 }, error: null });
  flag.on = true;
  role.value = "owner";
  role.throws = false;
  vi.mocked(loadTenantRoleFor).mockClear();
});

describe("reserveAdSpend bounded holds", () => {
  it("passes the verified dynamic daily factor for bounded and unbounded TikTok holds only", async () => {
    for (const bound of [{}, { ends_on: "2026-11-20" }]) {
      rpc.mockClear();
      await reserveAdSpend(D, { platform: "tiktok", op: "create", object_id: null, daily_delta_usd: 100, delivery_factor: 1.25, ...bound });
      expect(args()).toMatchObject({ p_daily_delta_usd: 100, p_factor: 1.25 });
    }
    rpc.mockClear();
    expect(await reserveAdSpend(D, { platform: "google", op: "raise", object_id: "o", daily_delta_usd: 100, delivery_factor: 1.25 })).toMatchObject({ status: "refused" });
    expect(rpc).not.toHaveBeenCalled();
  });
  it("a lifetime create sends p_cap_usd (rounded up to the cent)", async () => {
    await reserveAdSpend(D, { platform: "chatgpt", op: "create", object_id: null, daily_delta_usd: 0, lifetime_usd: 58.001 });
    expect(args()).toMatchObject({ p_cap_usd: 58.01, p_platform: "chatgpt", p_op: "create" });
    expect(args()).not.toHaveProperty("p_ends_on");
  });
  it("an end-dated create sends p_ends_on and the platform's hold factor", async () => {
    await reserveAdSpend(D, { platform: "meta", op: "create", object_id: null, daily_delta_usd: 10, ends_on: "2026-10-19" });
    expect(args()).toMatchObject({ p_ends_on: "2026-10-19", p_factor: 1.75 });
    rpc.mockClear();
    await reserveAdSpend(D, { platform: "tiktok", op: "create", object_id: null, daily_delta_usd: 20.01, ends_on: "2026-10-19" });
    expect(args()).toMatchObject({ p_ends_on: "2026-10-19", p_factor: 1 });
  });
  it("a bound on a raise, or a bad date / total, is refused before the RPC", async () => {
    const r1 = await reserveAdSpend(D, { platform: "meta", op: "raise", object_id: "o", daily_delta_usd: 5, ends_on: "2026-10-19" });
    const r2 = await reserveAdSpend(D, { platform: "meta", op: "create", object_id: null, daily_delta_usd: 5, ends_on: "Oct 19" });
    const r3 = await reserveAdSpend(D, { platform: "chatgpt", op: "create", object_id: null, daily_delta_usd: 0, lifetime_usd: -1 });
    for (const r of [r1, r2, r3]) expect(r).toEqual({ status: "refused", error: "cap_refuse: ad_budget_invalid_amount" });
    expect(rpc).not.toHaveBeenCalled();
  });
  it("a resume with a lifetime total and an end date sends both bounds at factor 1, with its worst-day share as the daily delta", async () => {
    await reserveAdSpend(D, { platform: "linkedin", op: "resume", object_id: "bound", daily_delta_usd: 20, currency: "USD", lifetime_usd: 600.001, ends_on: "2026-12-01" });
    expect(args()).toMatchObject({ p_op: "resume", p_platform: "linkedin", p_object_id: "bound", p_daily_delta_usd: 20, p_cap_usd: 600.01, p_ends_on: "2026-12-01", p_factor: 1 });
  });
  it("a resume with only one bound, or a bad bound, is refused before the RPC", async () => {
    const asks = [
      { lifetime_usd: 600 },
      { ends_on: "2026-12-01" },
      { lifetime_usd: 600, ends_on: "Dec 1" },
      { lifetime_usd: 0, ends_on: "2026-12-01" },
      { lifetime_usd: Number.NaN, ends_on: "2026-12-01" },
      { lifetime_usd: 1_000_000, ends_on: "2026-12-01" },
    ];
    for (const bound of asks) {
      const r = await reserveAdSpend(D, { platform: "linkedin", op: "resume", object_id: "bound", daily_delta_usd: 20, ...bound });
      expect(r).toEqual({ status: "refused", error: "cap_refuse: ad_budget_invalid_amount" });
    }
    const raise = await reserveAdSpend(D, { platform: "meta", op: "raise", object_id: "o", daily_delta_usd: 5, lifetime_usd: 600, ends_on: "2026-12-01" });
    expect(raise).toEqual({ status: "refused", error: "cap_refuse: ad_budget_invalid_amount" });
    expect(rpc).not.toHaveBeenCalled();
  });
  it("a founder approval (approved_by set, no source) by a live owner or admin sends p_over_cap_ok", async () => {
    await reserveAdSpend({ ...D, approved_by: "user-1", approved_by_source: null }, { platform: "meta", op: "raise", object_id: "o", daily_delta_usd: 5 });
    expect(args().p_over_cap_ok).toBe(true);
    expect(loadTenantRoleFor).toHaveBeenCalledWith("user-1", "tenant-1");
    rpc.mockClear();
    role.value = "admin";
    await reserveAdSpend({ ...D, approved_by: "user-2", approved_by_source: null }, { platform: "meta", op: "raise", object_id: "o", daily_delta_usd: 5 });
    expect(args().p_over_cap_ok).toBe(true);
  });
  it("a raise approved through approve_ad_raise_with_budget (body.budget_choice) never sends p_over_cap_ok: its hold was taken at tap", async () => {
    await reserveAdSpend({ ...D, approved_by: "user-1", approved_by_source: null, body: { budget_choice: { hold_idem: "d-1:raise" } } }, { platform: "meta", op: "raise", object_id: "o", daily_delta_usd: 5 });
    expect(args()).not.toHaveProperty("p_over_cap_ok");
  });
  it("a member, a role read error, or a cgo approval never sends p_over_cap_ok", async () => {
    role.value = "member";
    await reserveAdSpend({ ...D, approved_by: "user-1", approved_by_source: null }, { platform: "meta", op: "raise", object_id: "o", daily_delta_usd: 5 });
    expect(args()).not.toHaveProperty("p_over_cap_ok");
    rpc.mockClear();
    role.value = "owner";
    role.throws = true;
    await reserveAdSpend({ ...D, approved_by: "user-1", approved_by_source: null }, { platform: "meta", op: "raise", object_id: "o", daily_delta_usd: 5 });
    expect(args()).not.toHaveProperty("p_over_cap_ok");
    rpc.mockClear();
    role.throws = false;
    await reserveAdSpend({ ...D, approved_by: "user-1", approved_by_source: "cgo" }, { platform: "chatgpt", op: "create", object_id: null, daily_delta_usd: 0, lifetime_usd: 58 });
    expect(args()).not.toHaveProperty("p_over_cap_ok");
    expect(args().p_cap_usd).toBe(58);
  });
  it("kill switch off: none of the new args are sent", async () => {
    flag.on = false;
    await reserveAdSpend({ ...D, approved_by: "user-1", approved_by_source: null }, { platform: "chatgpt", op: "create", object_id: null, daily_delta_usd: 25, lifetime_usd: 58, ends_on: "2026-10-19" });
    for (const k of ["p_cap_usd", "p_ends_on", "p_factor", "p_over_cap_ok"]) expect(args()).not.toHaveProperty(k);
  });
  it("kill switch off: a resume with a lifetime total and an end date still sends both bounds, but never the owner's over-cap", async () => {
    flag.on = false;
    await reserveAdSpend({ ...D, approved_by: "user-1", approved_by_source: null }, { platform: "linkedin", op: "resume", object_id: "bound", daily_delta_usd: 100, currency: "USD", lifetime_usd: 100, ends_on: "2026-10-28" });
    expect(args()).toMatchObject({ p_op: "resume", p_daily_delta_usd: 100, p_cap_usd: 100, p_ends_on: "2026-10-28", p_factor: 1 });
    expect(args()).not.toHaveProperty("p_over_cap_ok");
    rpc.mockClear();
    const half = await reserveAdSpend(D, { platform: "linkedin", op: "resume", object_id: "bound", daily_delta_usd: 20, lifetime_usd: 0, ends_on: "2026-10-28" });
    expect(half).toEqual({ status: "refused", error: "cap_refuse: ad_budget_invalid_amount" });
    expect(rpc).not.toHaveBeenCalled();
  });
  it("an over_cap answer returns { status: 'held', over_cap: true }", async () => {
    rpc.mockResolvedValue({ data: { status: "held", amount_usd: 60, reason: "over_cap" }, error: null });
    const r = await reserveAdSpend({ ...D, approved_by: "user-1", approved_by_source: null }, { platform: "chatgpt", op: "create", object_id: null, daily_delta_usd: 0, lifetime_usd: 60 });
    expect(r).toMatchObject({ status: "held", over_cap: true, fresh: true });
  });
  it("a plain call (no bounds, no person) reads neither the switch nor a role", async () => {
    await reserveAdSpend(D, { platform: "meta", op: "raise", object_id: "o", daily_delta_usd: 5 });
    expect(Object.keys(args()).sort()).toEqual(["p_channel_action_id", "p_daily_delta_usd", "p_idem_key", "p_object_id", "p_op", "p_platform", "p_tenant_id"].sort());
    expect(loadTenantRoleFor).not.toHaveBeenCalled();
  });
});

describe("a lifetime total counts toward the daily limit (F3)", () => {
  it("worst-day share: factor x total / days, never above the total", async () => {
    const { lifetimeDailyUsd } = await import("../ad-budget");
    expect(lifetimeDailyUsd(100, 4, 2)).toBe(50);
    expect(lifetimeDailyUsd(58, 2, 2)).toBe(58);
    expect(lifetimeDailyUsd(58, 0.5, 2)).toBe(58);
  });
  it("the lifetime create sends its share as the daily delta, with factor 1 (not doubled again)", async () => {
    await reserveAdSpend(D, { platform: "chatgpt", op: "create", object_id: null, daily_delta_usd: 50, lifetime_usd: 100 });
    expect(args()).toMatchObject({ p_cap_usd: 100, p_daily_delta_usd: 50, p_factor: 1 });
  });
});
