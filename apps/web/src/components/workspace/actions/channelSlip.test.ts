import { describe, expect, it } from "vitest";
import { channelSlipStage } from "./channelSlip";

describe("channelSlipStage", () => {
  it("execution beats the row's status", () => {
    expect(channelSlipStage({ status: "acted", exec_status: "executed" })).toBe("done");
    expect(channelSlipStage({ status: "pending", exec_status: "failed", exec_bucket: "temporary" })).toBe("failed");
    expect(channelSlipStage({ status: "pending", exec_status: "queued" })).toBe("queued");
    expect(channelSlipStage({ status: "pending", exec_status: "dispatching" })).toBe("sending");
  });
  it("held for a person elsewhere is held, not sending", () => {
    expect(channelSlipStage({ status: "pending", exec_status: "dispatching", exec_waiting: "approvals" })).toBe("held");
  });
  it("a failure that may have landed in part is partial, never a clean miss", () => {
    expect(channelSlipStage({ status: "pending", exec_status: "failed", exec_bucket: "partial_risk" })).toBe("partial");
    expect(channelSlipStage({ status: "pending", exec_status: "failed", exec_bucket: null, exec_code: "exec_partial" })).toBe("partial");
    expect(channelSlipStage({ status: "pending", exec_status: "failed", exec_bucket: null, exec_code: "chatgpt_ads_admin_required" })).toBe("failed");
    expect(channelSlipStage({ status: "pending", exec_status: "failed", exec_bucket: "blocked_on_us" })).toBe("failed");
  });
  it("the approve request in flight shows as started", () => {
    expect(channelSlipStage({ status: "pending", exec_status: null }, { approving: true })).toBe("queued");
  });
  it("rows with no status of their own get no stage colour; ended rows are closed", () => {
    expect(channelSlipStage({})).toBeNull();
    expect(channelSlipStage({ status: "pending" })).toBe("waiting");
    expect(channelSlipStage({ status: "snoozed" })).toBe("closed");
    expect(channelSlipStage({ status: "rejected" })).toBe("closed");
    expect(channelSlipStage({ status: "acted", exec_status: null })).toBe("done");
  });
});
