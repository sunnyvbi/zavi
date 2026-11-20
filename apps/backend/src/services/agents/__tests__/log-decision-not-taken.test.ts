import { describe, it, expect, vi } from "vitest";
import { logDecisionNotTaken, type LogDecisionNotTakenDeps } from "../log-decision-not-taken";

function deps(insert = vi.fn(async () => {})): LogDecisionNotTakenDeps {
  return { insert };
}

describe("logDecisionNotTaken", () => {
  it("inserts a row with the enum + C14-safe fields (no raw payload)", async () => {
    const d = deps();
    const ok = await logDecisionNotTaken(
      {
        tenant_id: "t1",
        agent_run_id: "r1",
        agent_slug: "product-pm",
        decision_class: "pm.dispatch",
        rejection_type: "cap_exceeded",
        reason_code: "cap_exceeded",
      },
      d,
    );
    expect(ok).toBe(true);
    expect(d.insert).toHaveBeenCalledWith({
      tenant_id: "t1",
      agent_run_id: "r1",
      agent_slug: "product-pm",
      decision_class: "pm.dispatch",
      rejection_type: "cap_exceeded",
      reason_code: "cap_exceeded",
    });
  });

  it("defaults optional fields to null", async () => {
    const d = deps();
    await logDecisionNotTaken({ tenant_id: "t1", rejection_type: "agent_not_emitted" }, d);
    expect(d.insert).toHaveBeenCalledWith(
      expect.objectContaining({ agent_run_id: null, agent_slug: null, decision_class: null, reason_code: null }),
    );
  });

  it("FAIL-OPEN: an insert error returns false + does NOT throw (refusal path unbroken)", async () => {
    const d = deps(vi.fn(async (): Promise<void> => { throw new Error("db down"); }));
    const ok = await logDecisionNotTaken({ tenant_id: "t1", rejection_type: "autonomy_forbidden" }, d);
    expect(ok).toBe(false);
  });

  it("never stores a raw payload — only the declared C14-safe keys are passed through", async () => {
    const d = deps();
    await logDecisionNotTaken({ tenant_id: "t1", rejection_type: "condition_unmet", reason_code: "missing_repo_hint" }, d);
    const row = (d.insert as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual(
      ["agent_run_id", "agent_slug", "decision_class", "reason_code", "rejection_type", "tenant_id"].sort(),
    );
  });
});
