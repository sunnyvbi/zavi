import { describe, it, expect } from "vitest";
import { MONEY_PATH_SLUGS } from "@/services/agents/infra-retry";

describe("GAP 14 — MONEY_PATH_SLUGS firewall (drives the native-retry guard)", () => {
  it("contains the known money-moving agents", () => {
    expect(MONEY_PATH_SLUGS.has("performance-marketer")).toBe(true);
    expect(MONEY_PATH_SLUGS.has("dispute-response")).toBe(true);
  });

  it("is non-empty (a blank set would silently disable the money-path guard)", () => {
    expect(MONEY_PATH_SLUGS.size).toBeGreaterThan(0);
  });

  it("does NOT include read-only agents (they must stay auto-retryable)", () => {
    expect(MONEY_PATH_SLUGS.has("research")).toBe(false);
    expect(MONEY_PATH_SLUGS.has("chief-of-staff")).toBe(false);
  });
});
