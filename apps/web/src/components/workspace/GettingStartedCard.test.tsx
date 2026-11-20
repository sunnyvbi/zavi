import { describe, it, expect } from "vitest";
import {
  freshBuildCompleted,
  freshBuildCta,
  resolveRailPosture,
} from "./GettingStartedCard";

function st(first_approval_acted: boolean) {
  return {
    brain_seeded: true,
    connectors_count: 0,
    agents_run_count: 0,
    first_approval_acted,
    activated: false,
    next_best_action: { key: "run_agent", label: "x", href: "/x" },
  } as Parameters<typeof freshBuildCompleted>[0];
}

describe("freshBuildCompleted — fresh-build trail dot count", () => {
  it("is 0 before any build (none)", () => {
    expect(freshBuildCompleted(st(false), "none")).toBe(0);
  });

  it("counts a failed build as step 1 (described/attempted — not reset to 0)", () => {
    expect(freshBuildCompleted(st(false), "failed")).toBeGreaterThanOrEqual(1);
    expect(freshBuildCompleted(st(false), "failed")).toBe(1);
  });

  it("lights 1 dot while building", () => {
    expect(freshBuildCompleted(st(false), "building")).toBe(1);
  });

  it("lights 2 dots once live", () => {
    expect(freshBuildCompleted(st(false), "live")).toBe(2);
  });

  it("lights all 3 dots when live AND an output has been acted on", () => {
    expect(freshBuildCompleted(st(true), "live")).toBe(3);
  });
});

describe("freshBuildCta — failed routes to a recovery action", () => {
  it("uses a Retry build CTA on a failed build (not a passive 'View build')", () => {
    expect(freshBuildCta("failed").cta).toBe("Retry build");
  });
});

describe("resolveRailPosture — banner posture matches the build card's gate", () => {
  it("is fresh ONLY when intent is fresh AND the builder is enabled", () => {
    expect(resolveRailPosture("fresh", true)).toBe("fresh");
  });

  it("falls back to existing (has-product rail) when the builder is disabled — the dead-button case", () => {
    expect(resolveRailPosture("fresh", false)).toBe("existing");
  });

  it("is existing for a has-product tenant regardless of the flag", () => {
    expect(resolveRailPosture("existing", true)).toBe("existing");
    expect(resolveRailPosture("existing", false)).toBe("existing");
  });
});

describe("freshBuildCta — a paused build continues, never a paid restart", () => {
  it("paused → Continue build", () => {
    expect(freshBuildCta("failed", true)).toEqual({
      label: "Your build is paused. Continue it on Home",
      cta: "Continue build",
    });
  });
  it("a plain failure still offers Retry", () => {
    expect(freshBuildCta("failed", false).cta).toBe("Retry build");
  });
});
