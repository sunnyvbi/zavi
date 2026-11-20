import { describe, expect, it } from "vitest";
import { moveSlipStage } from "../MoveCard";

const L = (...st: string[]) => st.map((status) => ({ status }));

describe("moveSlipStage", () => {
  it("approved is queued (nothing changed yet); dispatching is applying", () => {
    expect(moveSlipStage(L("approved", "proposed"))).toBe("queued");
    expect(moveSlipStage(L("dispatching", "approved"))).toBe("sending");
  });
  it("a landed line beside one that did not land is partial (kept cuts, a raise still to finish, a failed raise)", () => {
    expect(moveSlipStage(L("acted", "rejected"))).toBe("partial");
    expect(moveSlipStage(L("acted", "proposed"))).toBe("partial");
    expect(moveSlipStage(L("acted", "dispatch_failed"))).toBe("partial");
    expect(moveSlipStage(L("acted", "approved"))).toBe("partial");
    expect(moveSlipStage(L("acted", "dispatching"))).toBe("partial");
  });
  it("a failed cut with the raise still open waits for the person, not 'failed'", () => {
    expect(moveSlipStage(L("dispatch_failed", "proposed"))).toBe("waiting");
  });
  it("the ends", () => {
    expect(moveSlipStage(L("proposed", "proposed"))).toBe("waiting");
    expect(moveSlipStage(L("dispatch_failed", "rejected"))).toBe("failed");
    expect(moveSlipStage(L("acted", "acted"))).toBe("done");
    expect(moveSlipStage(L("rejected", "rejected"))).toBe("rejected");
    expect(moveSlipStage(L("rejected", "expired"))).toBe("closed");
  });
});
