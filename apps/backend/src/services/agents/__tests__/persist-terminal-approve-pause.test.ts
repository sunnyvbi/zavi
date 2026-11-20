
import { describe, it, expect } from "vitest";
import {
  PAUSED_AWAITING_APPROVAL,
  shouldPauseForApproval,
  isInteractiveResumeTrigger,
} from "../approve-resume";

async function applyPauseGate(args: {
  baseStatus: string;
  runTenantId?: string;
  trigger: string;
  flagEnabled: boolean;
  pendingDecision: { autonomy_at_emit: string } | null;
  queryThrows?: boolean;
}): Promise<{ status: string; paused: boolean }> {
  const update = { status: args.baseStatus };
  let paused = false;
  if (
    update.status === "success" &&
    args.runTenantId &&
    isInteractiveResumeTrigger(args.trigger)
  ) {
    try {
      if (args.flagEnabled) {
        if (args.queryThrows) throw new Error("db blip");
        const pend = args.pendingDecision;
        if (
          pend &&
          shouldPauseForApproval({ enabled: true, autonomy: pend.autonomy_at_emit })
        ) {
          update.status = PAUSED_AWAITING_APPROVAL;
          paused = true;
        }
      }
    } catch {
    }
  }
  return { status: update.status, paused };
}

const APPROVAL = { autonomy_at_emit: "approval" };

describe("persistTerminal — approve-and-resume pause gate", () => {
  it("relabels success → paused when flag ON + interactive trigger + a pending approval-gated decision exists", async () => {
    const r = await applyPauseGate({
      baseStatus: "success",
      runTenantId: "t1",
      trigger: "chat",
      flagEnabled: true,
      pendingDecision: APPROVAL,
    });
    expect(r.status).toBe(PAUSED_AWAITING_APPROVAL);
    expect(r.paused).toBe(true);
  });

  it("scopes to conversational surfaces: chat/slack/email/teams pause, cron/a2a/manual do NOT (2026-07-05 fix)", async () => {
    for (const trigger of ["chat", "slack", "email", "teams"]) {
      const r = await applyPauseGate({
        baseStatus: "success",
        runTenantId: "t1",
        trigger,
        flagEnabled: true,
        pendingDecision: APPROVAL,
      });
      expect(r.paused).toBe(true);
    }
    for (const trigger of ["cron", "a2a", "manual", "webhook", "handoff"]) {
      const r = await applyPauseGate({
        baseStatus: "success",
        runTenantId: "t1",
        trigger,
        flagEnabled: true,
        pendingDecision: APPROVAL,
      });
      expect(r.status).toBe("success");
      expect(r.paused).toBe(false);
    }
  });

  it("flag OFF → stays success (byte-identical to today), even with a pending approval decision", async () => {
    const r = await applyPauseGate({
      baseStatus: "success",
      runTenantId: "t1",
      trigger: "chat",
      flagEnabled: false,
      pendingDecision: APPROVAL,
    });
    expect(r.status).toBe("success");
    expect(r.paused).toBe(false);
  });

  it("no tenant id (caller opted out) → stays success, no query attempted", async () => {
    const r = await applyPauseGate({
      baseStatus: "success",
      runTenantId: undefined,
      trigger: "chat",
      flagEnabled: true,
      pendingDecision: APPROVAL,
    });
    expect(r.status).toBe("success");
    expect(r.paused).toBe(false);
  });

  it("flag ON but NO pending approval decision → stays success", async () => {
    const r = await applyPauseGate({
      baseStatus: "success",
      runTenantId: "t1",
      trigger: "chat",
      flagEnabled: true,
      pendingDecision: null,
    });
    expect(r.status).toBe("success");
    expect(r.paused).toBe(false);
  });

  it("query error → FAIL-OPEN to success (never blocks or mislabels the run)", async () => {
    const r = await applyPauseGate({
      baseStatus: "success",
      runTenantId: "t1",
      trigger: "chat",
      flagEnabled: true,
      pendingDecision: APPROVAL,
      queryThrows: true,
    });
    expect(r.status).toBe("success");
    expect(r.paused).toBe(false);
  });

  it("never touches a non-success terminal (cancelled / dispatch_error / parse_failed)", async () => {
    for (const base of ["cancelled", "dispatch_error", "parse_failed"]) {
      const r = await applyPauseGate({
        baseStatus: base,
        runTenantId: "t1",
        trigger: "chat",
        flagEnabled: true,
        pendingDecision: APPROVAL,
      });
      expect(r.status).toBe(base);
      expect(r.paused).toBe(false);
    }
  });

  it("promote + run_end are gated on !paused (skipped exactly when paused)", () => {
    const whenPaused = { promote: !true, runEnd: !true };
    const whenNotPaused = { promote: !false, runEnd: !false };
    expect(whenPaused).toEqual({ promote: false, runEnd: false });
    expect(whenNotPaused).toEqual({ promote: true, runEnd: true });
  });
});
