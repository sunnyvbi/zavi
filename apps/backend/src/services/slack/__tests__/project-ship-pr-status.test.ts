import { describe, it, expect } from "vitest";
import { projectShipPrStatus } from "../project-ship-pr-status";

const slack = { trigger: "slack" as const, surface: "slack" as const };

describe("projectShipPrStatus", () => {
  it("proposed + Slack auto → 'opening now', not the old lie or a bogus approve", () => {
    const line = projectShipPrStatus({ status: "proposed", autonomy_at_emit: "auto" }, slack);
    expect(line).toContain("Opening the PR now");
    expect(line).not.toContain("Approve to open");
  });

  it("proposed + approval-gated + not approved → held/approve copy, never 'opening'", () => {
    const line = projectShipPrStatus(
      { status: "proposed", autonomy_at_emit: "approval" },
      slack,
    );
    expect(line).toBeTruthy();
    expect(line!.toLowerCase()).not.toContain("opening the pr");
    expect(line!).toContain("Approve");
  });

  it("dispatching → 'opening now' (genuinely on its way)", () => {
    const line = projectShipPrStatus({ status: "dispatching" }, slack);
    expect(line).toContain("Opening the PR now");
  });

  it("approved → 'opening now'", () => {
    const line = projectShipPrStatus({ status: "approved", approved_by: "u_123" }, slack);
    expect(line).toContain("Opening the PR now");
  });

  it("proposed but already approved → 'opening now', not held", () => {
    const line = projectShipPrStatus({ status: "proposed", approved_by: "u_123" }, slack);
    expect(line).toContain("Opening the PR now");
    expect(line).not.toContain("Approve to open");
  });

  it("acted → null (dispatch-notice posts the real link; no double-post)", () => {
    expect(projectShipPrStatus({ status: "acted" }, slack)).toBeNull();
  });

  it("dispatch_error set → 'didn't open', never a success line", () => {
    const line = projectShipPrStatus(
      { status: "dispatching", dispatch_error: "404 base branch not found" },
      slack,
    );
    expect(line!.toLowerCase()).toContain("didn't open");
    expect(line!.toLowerCase()).not.toContain("opening the pr now");
  });

  it("rejected / expired / stale → 'didn't open'", () => {
    for (const status of ["rejected", "expired", "stale"]) {
      expect(projectShipPrStatus({ status }, slack)!.toLowerCase()).toContain("didn't open");
    }
  });

  it("autonomous trigger (cron) proposed → 'opening now' (auto-open, not held)", () => {
    const line = projectShipPrStatus({ status: "proposed" }, { trigger: "cron", surface: "slack" });
    expect(line).toContain("Opening the PR now");
  });

  it("unknown status → null (fail-safe: say nothing rather than guess)", () => {
    expect(projectShipPrStatus({ status: "queued" }, slack)).toBeNull();
  });
});
