import { beforeEach, describe, expect, it, vi } from "vitest";
import { overProjectionGate } from "@/services/decisions/ad-budget";
const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/services/tenant-client", async (orig) => ({
  ...(await orig<object>()),
  tenantRpc: mocks.rpc,
}));
import { reserveXSpend, settleXSpend } from "./spend";
const row = {
  body: {},
  id: "approved-action",
  tenant_id: "tenant",
  exec_source: "channel_actions",
  approved_by_source: "founder",
};
beforeEach(() => {
  vi.clearAllMocks();
});
describe("X Ads shared reservation contract", () => {
  it("passes USD, action identity and positive daily capacity to the existing atomic RPC", async () => {
    mocks.rpc.mockResolvedValue({ data: { status: "held" }, error: null });
    const hold = await reserveXSpend(row, "create", null, 12.345, "USD");
    expect(hold.status).toBe("held");
    expect(mocks.rpc).toHaveBeenCalledWith(
      "tenant",
      "reserve_ad_spend",
      expect.objectContaining({
        p_platform: "x",
        p_op: "create",
        p_daily_delta_usd: 12.35,
        p_channel_action_id: "approved-action",
        p_idem_key: "approved-action:create",
      }),
    );
  });
  it("refuses cap rejection and unreadable budget state", async () => {
    mocks.rpc.mockResolvedValue({
      data: { status: "refused", reason: "daily_limit" },
      error: null,
    });
    await expect(
      reserveXSpend(row, "resume", "c1", 12, "USD"),
    ).rejects.toMatchObject({ code: "x_ads_budget_refused" });
    mocks.rpc.mockRejectedValue(new Error("unavailable"));
    await expect(
      reserveXSpend(row, "raise", "c1", 1, "USD"),
    ).rejects.toMatchObject({ code: "x_ads_budget_refused" });
  });
  it("a CGO write cannot fall through when there is no budget", async () => {
    mocks.rpc.mockResolvedValue({ data: { status: "no_budget" }, error: null });
    await expect(
      reserveXSpend(
        { ...row, approved_by_source: "cgo" },
        "create",
        null,
        5,
        "USD",
      ),
    ).rejects.toMatchObject({ code: "x_ads_budget_required" });
  });
  it("retains a reservation after an uncertain write", async () => {
    const { ExpectedToolError } = await import("@/services/tools/types");
    await settleXSpend(
      {
        status: "held",
        tenant_id: "tenant",
        idem_key: "id:create",
        fresh: true,
      },
      null,
      new ExpectedToolError("x_ads_outcome_unknown", "network lost"),
      true,
    );
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("requires a persisted approval identity", async () => {
    await expect(
      reserveXSpend(
        { tenant_id: "tenant", body: {} },
        "resume",
        "c1",
        1,
        "USD",
      ),
    ).rejects.toMatchObject({ code: "x_ads_action_missing" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe("X in-flight holds (ad-hold-resolve)", async () => {
  const { inflightOutcome } = await import("@/services/decisions/ad-hold-resolve");
  const now = new Date("2026-10-09T05:00:00Z");
  const hold = { id: "h", platform: "x", object_id: "c1", op: "resume", updated_at: "2026-10-09T01:00:00Z" };
  const ledger = { object_id: "c1", campaign_id: "c1", level: "campaign", budget_kind: "daily", budget_usd: 10, campaign_budget_usd: null, status: "ACTIVE", as_of: now.toISOString() };
  const resume = { exec_class: "x_ads.set_status", body: { status: "ACTIVE" } };
  const raise = { exec_class: "x_ads.update_campaign", body: { changes: { daily_budget: 20 }, before: { daily_budget: 10 } } };
  it("a resume that a fresh read shows still paused is released; an active one commits", () => {
    expect(inflightOutcome(hold, resume, [{ ...ledger, status: "PAUSED" }], now)).toBe("not_landed");
    expect(inflightOutcome(hold, resume, [ledger], now)).toBe("landed");
    expect(inflightOutcome(hold, resume, [{ ...ledger, status: "PAUSED", as_of: "2026-10-09T00:30:00Z" }], now)).toBeNull();
  });
  it("a raise is released only when the budget is still at or below its old value", () => {
    const h = { ...hold, op: "raise" };
    expect(inflightOutcome(h, raise, [ledger], now)).toBe("not_landed");
    expect(inflightOutcome(h, raise, [{ ...ledger, budget_usd: 20 }], now)).toBe("landed");
    expect(inflightOutcome(h, raise, [{ ...ledger, budget_usd: 15 }], now)).toBeNull();
    expect(inflightOutcome(h, { ...raise, body: { changes: { daily_budget: 20 } } }, [ledger], now)).toBeNull();
  });
});

describe("xActionRaisesSpend (the owner/admin approve gate)", async () => {
  const { xActionRaisesSpend } = await import("./schema");
  it.each([
    ["x_ads.create_campaign", { launch: "ACTIVE" }],
    ["x_ads.set_status", { status: "ACTIVE" }],
    ["x_ads.update_campaign", { changes: { daily_budget: 20 }, before: { daily_budget: 10 } }],
    ["x_ads.update_campaign", { changes: { total_budget: 200 }, before: { daily_budget: 10, total_budget: 100 } }],
    ["x_ads.update_campaign", {}],
    ["x_ads.manage_objects", { request: { operation: "update_ad_group", changes: { entity_status: "ACTIVE" } } }],
    ["x_ads.manage_objects", { request: { operation: "update_ad_group", changes: { daily_budget: 5 } } }],
    ["x_ads.manage_objects", { request: { operation: "update_ad_group", changes: { end_time: "2026-12-01T00:00:00Z" } } }],
    ["x_ads.manage_objects", {}],
  ])("%s %j raises spend", (cls, body) => expect(xActionRaisesSpend(cls, body)).toBe(true));
  it.each([
    ["x_ads.create_campaign", { launch: "PAUSED" }],
    ["x_ads.set_status", { status: "PAUSED" }],
    ["x_ads.update_campaign", { changes: { daily_budget: 5 }, before: { daily_budget: 10 } }],
    ["x_ads.update_campaign", { changes: { name: "New" }, before: { daily_budget: 10 } }],
    ["x_ads.manage_objects", { request: { operation: "delete_ad_group" } }],
    ["x_ads.manage_objects", { request: { operation: "update_ad_group", changes: { entity_status: "PAUSED" } } }],
  ])("%s %j stays open to members", (cls, body) => expect(xActionRaisesSpend(cls, body)).toBe(false));
});

beforeEach(() => {
  vi.spyOn(overProjectionGate, "read").mockResolvedValue(null);
});
