import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  calls: [] as Array<{ tid: string; name: string; args: Record<string, unknown> }>,
  reply: { data: null as unknown, error: null as null | { message: string } },
  flat: false,
}));

vi.mock("../flat-pricing", () => ({ isRunFlatBilled: async () => h.flat }));

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantRpc: async (tid: string, name: string, args: Record<string, unknown>) => {
    h.calls.push({ tid, name, args });
    return h.reply;
  },
}));

import { recordLateToolCharge, settleLateToolCharge } from "../tool-charges";

const T = "11111111-1111-1111-1111-111111111111";
const R = "22222222-2222-2222-2222-222222222222";

beforeEach(() => {
  h.calls.length = 0;
  h.reply = { data: null, error: null };
  h.flat = false;
});

describe("recordLateToolCharge", () => {
  it("records the reserve through the tenant-injected RPC", async () => {
    h.reply = { data: "recorded", error: null };
    expect(await recordLateToolCharge({ tenantId: T, runId: R, toolCallId: "tc_1", reservedUsd: 0.46 })).toBe("recorded");
    expect(h.calls).toEqual([
      {
        tid: T,
        name: "record_late_tool_charge",
        args: { p_run_id: R, p_tool_call_id: "tc_1", p_card_id: null, p_reserved_usd: 0.46 },
      },
    ]);
  });

  it("refuses a non-positive reserve before calling the DB", async () => {
    await expect(recordLateToolCharge({ tenantId: T, runId: R, toolCallId: "tc", reservedUsd: 0 })).rejects.toThrow();
    expect(h.calls).toHaveLength(0);
  });

  it("surfaces a DB error (tenant mismatch) instead of swallowing it", async () => {
    h.reply = { data: null, error: { message: "tenant_mismatch" } };
    await expect(recordLateToolCharge({ tenantId: T, runId: R, toolCallId: "tc", reservedUsd: 0.46 })).rejects.toThrow(
      /tenant_mismatch/,
    );
  });
});

describe("settleLateToolCharge", () => {
  it("passes the actual cost and returns the refund split", async () => {
    h.reply = { data: { status: "refunded", credits: 150, daily: 0, included: 50, purchased: 100, forfeited: 0 }, error: null };
    const r = await settleLateToolCharge({ tenantId: T, runId: R, toolCallId: "tc_1", actualUsd: 0.085 });
    expect(r).toMatchObject({ status: "refunded", credits: 150 });
    expect(h.calls[0]).toEqual({
      tid: T,
      name: "refund_tool_charge",
      args: { p_run_id: R, p_tool_call_id: "tc_1", p_actual_usd: 0.085 },
    });
  });

  it("refuses a negative actual before calling the DB", async () => {
    await expect(settleLateToolCharge({ tenantId: T, runId: R, toolCallId: "tc", actualUsd: -0.01 })).rejects.toThrow();
    expect(h.calls).toHaveLength(0);
  });

  it("a flat-billed run gets no late-check refund (actual sent above any reserve)", async () => {
    h.flat = true;
    h.reply = { data: { status: "nothing_to_refund", credits: 0 }, error: null };
    await settleLateToolCharge({ tenantId: T, runId: R, toolCallId: "tc_1", actualUsd: 0.02 });
    expect(h.calls[0].args).toEqual({ p_run_id: R, p_tool_call_id: "tc_1", p_actual_usd: Number.MAX_SAFE_INTEGER });
  });
});
