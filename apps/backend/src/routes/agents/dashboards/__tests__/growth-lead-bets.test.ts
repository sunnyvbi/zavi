
import { describe, it, expect, vi, beforeEach } from "vitest";
import { build } from "../growth-lead";
import type { DashboardContext } from "../_contract";

const mockGetBoolSetting = vi.fn();
vi.mock("@/services/settings", () => ({
  getBoolSetting: (...a: unknown[]) => mockGetBoolSetting(...a),
}));

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";

type Row = Record<string, unknown> & { tenant_id: string; decision_class: string };

function makeSb(rows: Row[]) {
  let tenantEq: string | null = null;
  let classIn: string[] | null = null;
  const chain: Record<string, unknown> = {
    from() {
      return chain;
    },
    select: () => chain,
    eq: (col: string, val: string) => {
      if (col === "tenant_id") tenantEq = val;
      return chain;
    },
    in: (col: string, vals: string[]) => {
      if (col === "decision_class") classIn = vals;
      return chain;
    },
    order: () => chain,
    limit: () => chain,
    then(resolve: (v: { data: unknown[]; error: null }) => unknown) {
      let data = rows;
      if (tenantEq !== null) data = data.filter((r) => r.tenant_id === tenantEq);
      if (classIn !== null)
        data = data.filter((r) => classIn!.includes(r.decision_class));
      return Promise.resolve({ data, error: null }).then(resolve);
    },
  };
  return chain;
}

function ctx(tenantId: string, rows: Row[]): DashboardContext {
  return {
    tenantId,
    accessToken: "tok",
    ctx: { tenant_id: tenantId } as unknown,
    sb: makeSb(rows),
  } as unknown as DashboardContext;
}

const betA: Row = {
  id: "bet-a",
  tenant_id: TENANT_A,
  decision_class: "growth-lead.reallocate-budget",
  status: "proposed",
  emitted_at: "2026-06-19T00:00:00Z",
  body: {
    bet_claim: "Shift $500/wk from Meta to founder-led LinkedIn",
    from_channel: "Meta",
    to_channel: "LinkedIn",
    amount_usd: 500,
    amount_qualitative: false,
    confidence: "high",
    rationale: "internal model prose that could mention a customer name",
    source_signals: [{ agent: "performance-marketer", note_id: "n-1", signal: "x" }],
    source_run_id: "run-secret",
    draft: "Subindexed outbound copy to a named prospect — PII risk",
  },
};

const betB: Row = {
  id: "bet-b",
  tenant_id: TENANT_B,
  decision_class: "growth-lead.reallocate-budget",
  status: "proposed",
  emitted_at: "2026-06-19T00:00:00Z",
  body: { bet_claim: "TENANT B SECRET BET — must never appear for A" },
};

const dispatchRow: Row = {
  id: "disp-1",
  tenant_id: TENANT_A,
  decision_class: "growth-lead.dispatch-specialist",
  status: "proposed",
  emitted_at: "2026-06-19T00:00:00Z",
  body: { target_agent_slug: "performance-marketer", intent: "do thing" },
};

beforeEach(() => {
  mockGetBoolSetting.mockReset();
  mockGetBoolSetting.mockResolvedValue(false);
});

describe("growth-lead dashboard — Recent growth bets richness", () => {
  it("surfaces tenant A's bets only — tenant B's are excluded (cross-tenant floor)", async () => {
    const d = (await build(ctx(TENANT_A, [betA, betB]))) as Record<string, any>;
    const bets = d.bets as Array<Record<string, unknown>>;
    expect(bets).toHaveLength(1);
    expect(bets[0].id).toBe("bet-a");
    const flat = JSON.stringify(d);
    expect(flat).not.toContain("bet-b");
    expect(flat).not.toContain("TENANT B SECRET BET");
  });

  it("never surfaces raw body fields (rationale / source_signals / draft / run id)", async () => {
    const d = (await build(ctx(TENANT_A, [betA]))) as Record<string, any>;
    const flat = JSON.stringify(d);
    expect(flat).not.toContain("internal model prose");
    expect(flat).not.toContain("source_signals");
    expect(flat).not.toContain("performance-marketer");
    expect(flat).not.toContain("run-secret");
    expect(flat).not.toContain("PII risk");
    expect(flat).not.toContain("rationale");
    const bet = (d.bets as Array<Record<string, unknown>>)[0];
    expect(bet.claim).toBe("Shift $500/wk from Meta to founder-led LinkedIn");
    expect(bet.kind).toBe("budget");
    expect(bet.from_channel).toBe("Meta");
    expect(bet.to_channel).toBe("LinkedIn");
    expect(bet.amount_usd).toBe(500);
    expect(bet.confidence).toBe("high");
    expect(bet.status).toBe("proposed");
  });

  it("excludes non-bet growth-lead classes (dispatch-specialist is not a bet)", async () => {
    const d = (await build(ctx(TENANT_A, [betA, dispatchRow]))) as Record<string, any>;
    const bets = d.bets as Array<Record<string, unknown>>;
    expect(bets).toHaveLength(1);
    expect(bets[0].id).toBe("bet-a");
    expect(JSON.stringify(d)).not.toContain("disp-1");
  });

  it("first-time / empty: no bets + no connectors → connect state, no throw", async () => {
    const d = (await build(ctx(TENANT_A, []))) as Record<string, any>;
    expect(d.connected).toBe(false);
    expect(d.bets).toBeUndefined();
    expect(d.autopilot_enabled).toBeUndefined();
  });

  it("reports autopilot_enabled as a constant and reads no setting for it", async () => {
    mockGetBoolSetting.mockResolvedValue(false);
    const d = (await build(ctx(TENANT_A, [betA]))) as Record<string, any>;
    expect(d.connected).toBe(true);
    expect(d.autopilot_enabled).toBe(true);
    expect(mockGetBoolSetting).not.toHaveBeenCalledWith("autopilot_enabled", TENANT_A);
  });

  it("does not throw when the settings store is unhealthy", async () => {
    mockGetBoolSetting.mockRejectedValue(new Error("settings read blip"));
    const d = (await build(ctx(TENANT_A, [betA]))) as Record<string, any>;
    expect(d.connected).toBe(true);
    expect(d.autopilot_enabled).toBe(true);
  });
});
