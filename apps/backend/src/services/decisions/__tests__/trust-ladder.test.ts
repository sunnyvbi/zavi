
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => {
  const state: {
    trustLevel: unknown;
    classRow: { never_auto: boolean | null } | null;
    classErr: { message: string } | null;
    ownerRow: { user_id: string } | null;
  } = {
    trustLevel: "L0",
    classRow: { never_auto: false },
    classErr: null,
    ownerRow: { user_id: "owner-1" },
  };

  const getStringSetting = vi.fn(async () => state.trustLevel as string);
  const decideOnDecision = vi.fn(async () => ({
    ok: true,
    code: "ok",
    changed: true,
    status: "approved",
    decision_id: "dec-1",
    allowlisted: false,
  }));
  const logEvent = vi.fn(async () => undefined);

  const serviceClient = vi.fn(() => ({
    from: (table: string) => ({
      select: (_cols: string) => ({
        eq: (_c1: string, _v1: string) => ({
          maybeSingle: async () => {
            if (table === "decision_classes") {
              return { data: state.classRow, error: state.classErr };
            }
            return { data: null, error: null };
          },
          eq: (_c2: string, _v2: string) => ({
            maybeSingle: async () => {
              if (table === "tenant_users") {
                return { data: state.ownerRow, error: null };
              }
              return { data: null, error: null };
            },
          }),
        }),
      }),
    }),
  }));

  return { state, getStringSetting, decideOnDecision, logEvent, serviceClient };
});

vi.mock("@/services/settings", () => ({
  getStringSetting: mocks.getStringSetting,
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: mocks.serviceClient,
}));
vi.mock("@/services/approvals/decide-service", () => ({
  decideOnDecision: mocks.decideOnDecision,
}));
vi.mock("@/services/logging/logEvent", () => ({
  logEvent: mocks.logEvent,
}));

import {
  coerceTrustLevel,
  maybeAutoApproveDailyPlan,
  TRUST_LADDER_CLASS,
  TRUST_LEVELS,
} from "../trust-ladder";

beforeEach(() => {
  mocks.state.trustLevel = "L0";
  mocks.state.classRow = { never_auto: false };
  mocks.state.classErr = null;
  mocks.state.ownerRow = { user_id: "owner-1" };
  mocks.getStringSetting.mockClear();
  mocks.decideOnDecision.mockClear();
  mocks.logEvent.mockClear();
});

describe("coerceTrustLevel — fail-closed to L0", () => {
  it("only 'L1' resolves to L1; everything else (incl. reserved L2/L3 and garbage) is L0", () => {
    expect(coerceTrustLevel("L1")).toBe("L1");
    expect(coerceTrustLevel("L0")).toBe("L0");
    expect(coerceTrustLevel("L2")).toBe("L0");
    expect(coerceTrustLevel("L3")).toBe("L0");
    expect(coerceTrustLevel("L5")).toBe("L0");
    expect(coerceTrustLevel("")).toBe("L0");
    expect(coerceTrustLevel(undefined)).toBe("L0");
    expect(coerceTrustLevel(1)).toBe("L0");
  });

  it("TRUST_LEVELS is exactly [L0, L1] — L2/L3 must not be accepted until their slices ship", () => {
    expect([...TRUST_LEVELS]).toEqual(["L0", "L1"]);
  });
});

describe("maybeAutoApproveDailyPlan", () => {
  const args = { tenant_id: "tnt-A", decision_id: "dec-1" };

  it("L0 (default): NO-OP — decideOnDecision never called, decision stays proposed", async () => {
    mocks.state.trustLevel = "L0";
    const out = await maybeAutoApproveDailyPlan(args);
    expect(out).toEqual({ attempted: false, reason: "level_l0" });
    expect(mocks.decideOnDecision).not.toHaveBeenCalled();
  });

  it("unknown stored level (e.g. 'L5'): treated as L0 — NO-OP", async () => {
    mocks.state.trustLevel = "L5";
    const out = await maybeAutoApproveDailyPlan(args);
    expect(out).toEqual({ attempted: false, reason: "level_l0" });
    expect(mocks.decideOnDecision).not.toHaveBeenCalled();
  });

  it("L1: approves via the SHARED decide service with the tenant OWNER as system actor", async () => {
    mocks.state.trustLevel = "L1";
    const out = await maybeAutoApproveDailyPlan(args);
    expect(mocks.decideOnDecision).toHaveBeenCalledTimes(1);
    expect(mocks.decideOnDecision).toHaveBeenCalledWith({
      decision_id: "dec-1",
      tenant_id: "tnt-A",
      action: "approve",
      actor: { user_id: "owner-1" },
    });
    expect(out).toEqual({ attempted: true, approved: true, reason: undefined });
    expect(mocks.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "autopilot.trust_ladder.auto_approved",
        message: "auto-approved by trust-ladder L1",
        tenant_id: "tnt-A",
        meta: { decision_class: TRUST_LADDER_CLASS },
      }),
    );
  });

  it("never_auto clamp wins: L1 with never_auto=true class is NOT approved", async () => {
    mocks.state.trustLevel = "L1";
    mocks.state.classRow = { never_auto: true };
    const out = await maybeAutoApproveDailyPlan(args);
    expect(out).toEqual({ attempted: false, reason: "never_auto_clamp" });
    expect(mocks.decideOnDecision).not.toHaveBeenCalled();
  });

  it("class-read error clamps (fail-closed): no approve", async () => {
    mocks.state.trustLevel = "L1";
    mocks.state.classRow = null;
    mocks.state.classErr = { message: "boom" };
    const out = await maybeAutoApproveDailyPlan(args);
    expect(out).toEqual({ attempted: false, reason: "never_auto_clamp" });
    expect(mocks.decideOnDecision).not.toHaveBeenCalled();
  });

  it("no owner row: skip (no valid actor) — decision stays proposed", async () => {
    mocks.state.trustLevel = "L1";
    mocks.state.ownerRow = null;
    const out = await maybeAutoApproveDailyPlan(args);
    expect(out).toEqual({ attempted: false, reason: "no_owner_actor" });
    expect(mocks.decideOnDecision).not.toHaveBeenCalled();
  });

  it("decide-service throw NEVER propagates — resolves approved:false (L0 fallback)", async () => {
    mocks.state.trustLevel = "L1";
    mocks.decideOnDecision.mockRejectedValueOnce(new Error("network"));
    const out = await maybeAutoApproveDailyPlan(args);
    expect(out).toEqual({ attempted: true, approved: false, reason: "threw" });
  });

  it("a non-ok decide result reports approved:false with the code (decision stays proposed)", async () => {
    mocks.state.trustLevel = "L1";
    mocks.decideOnDecision.mockResolvedValueOnce({
      ok: false,
      code: "not_member",
      changed: false,
      status: "proposed",
      decision_id: "dec-1",
      allowlisted: false,
    });
    const out = await maybeAutoApproveDailyPlan(args);
    expect(out).toEqual({ attempted: true, approved: false, reason: "not_member" });
  });
});
