import { describe, it, expect } from "vitest";
import { decideBuilderRetry, type BuilderRetryDecision } from "./BuilderChatCard";

const base = {
  nonce: 5,
  lastHandled: 0,
  loaded: true,
  enabled: true,
  buildAppIntent: "fresh",
  status: "failed",
  hasBuildTurn: true,
};
function decide(over: Partial<typeof base>): BuilderRetryDecision {
  return decideBuilderRetry({ ...base, ...over });
}

describe("decideBuilderRetry — banner retry bridge race logic", () => {
  it("handles a fresh, enabled, loaded, failed build with a loaded objective", () => {
    expect(decide({})).toBe("handle");
  });

  it("WAITS (never acks) while this card's own hook is still unloaded — the cold-mount race", () => {
    expect(decide({ loaded: false })).toBe("wait");
    expect(
      decide({ loaded: false, enabled: false, status: "none" }),
    ).toBe("wait");
  });

  it("does nothing when there is no request or it was already handled", () => {
    expect(decide({ nonce: 0 })).toBe("wait");
    expect(decide({ nonce: 5, lastHandled: 5 })).toBe("wait");
  });

  it("acks without retrying when this isn't the build card (disabled or non-fresh)", () => {
    expect(decide({ enabled: false })).toBe("ack");
    expect(decide({ buildAppIntent: "existing" })).toBe("ack");
  });

  it("acks without retrying when the build isn't failed (nothing to retry)", () => {
    expect(decide({ status: "live" })).toBe("ack");
    expect(decide({ status: "building" })).toBe("ack");
    expect(decide({ status: "none" })).toBe("ack");
  });

  it("WAITS on a failed build whose objective hasn't loaded yet (so prefill isn't empty)", () => {
    expect(decide({ hasBuildTurn: false })).toBe("wait");
  });

  it("never returns 'handle' for any non-failed status — retry only recovers a failure", () => {
    for (const status of ["none", "building", "live"]) {
      expect(decide({ status })).not.toBe("handle");
    }
  });

  it("re-handles a second retry once the issued nonce climbs past lastHandled (monotonic)", () => {
    expect(decide({ nonce: 1, lastHandled: 0 })).toBe("handle");
    expect(decide({ nonce: 2, lastHandled: 1 })).toBe("handle");
    expect(decide({ nonce: 1, lastHandled: 1 })).toBe("wait");
  });
});
