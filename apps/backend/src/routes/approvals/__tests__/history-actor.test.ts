import { describe, it, expect } from "vitest";
import { actorLabel, effectiveActor, type DecisionRow } from "@/routes/approvals/history";

const row = (o: Partial<DecisionRow>): DecisionRow => ({
  status: "approved",
  approved_by: null,
  rejected_by: null,
  ...o,
});

describe("effectiveActor (Gap 5 S5 history attribution)", () => {
  it("approved row → approver", () => {
    expect(effectiveActor(row({ status: "approved", approved_by: "u-app" }))).toEqual({
      kind: "approved",
      user_id: "u-app",
    });
  });

  it("rejected row (new) → rejecter from rejected_by", () => {
    expect(
      effectiveActor(row({ status: "rejected", rejected_by: "u-rej", approved_by: null })),
    ).toEqual({ kind: "rejected", user_id: "u-rej" });
  });

  it("LEGACY rejected row (rejected_by null) → falls back to approved_by, STILL 'rejected' (not 'approved')", () => {
    expect(
      effectiveActor(row({ status: "rejected", rejected_by: null, approved_by: "u-legacy-rejecter" })),
    ).toEqual({ kind: "rejected", user_id: "u-legacy-rejecter" });
  });

  it("auto-fired row (no human) → auto, null actor", () => {
    expect(effectiveActor(row({ status: "acted", approved_by: null }))).toEqual({
      kind: "auto",
      user_id: null,
    });
  });

  it("dispatched-after-approval row → approver (kind approved)", () => {
    expect(effectiveActor(row({ status: "dispatching", approved_by: "u-app" }))).toEqual({
      kind: "approved",
      user_id: "u-app",
    });
  });
});

describe("actorLabel: a CGO approval reads as Autopilot, not the owner", () => {
  const names = new Map([["u-owner", "Ravi Ramadasu"]]);
  it("an approval the CGO made (approved_by_source cgo) is labelled Autopilot", () => {
    const r = row({ status: "acted", approved_by: "u-owner", approved_by_source: "cgo" });
    expect(actorLabel(r, effectiveActor(r), names)).toBe("Autopilot");
  });
  it("the owner's own approval keeps their name, and a reject is never relabelled", () => {
    const own = row({ status: "acted", approved_by: "u-owner", approved_by_source: null });
    expect(actorLabel(own, effectiveActor(own), names)).toBe("Ravi Ramadasu");
    const rej = row({ status: "rejected", rejected_by: "u-owner", approved_by_source: "cgo" });
    expect(actorLabel(rej, effectiveActor(rej), names)).toBe("Ravi Ramadasu");
  });
});
