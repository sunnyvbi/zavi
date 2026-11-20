import { describe, it, expect } from "vitest";
import { reaperAllowedInEnv } from "../reaper-env-scope";

describe("reaperAllowedInEnv", () => {
  it("prod reaper (EXECUTION_ENV unset) is allowed — unchanged behavior", () => {
    expect(reaperAllowedInEnv({}).allowed).toBe(true);
    expect(reaperAllowedInEnv({ EXECUTION_ENV: "prod" }).allowed).toBe(true);
  });

  it("staging reaper is HARD-OFF (refused) — staging reaping is Phase 2", () => {
    const r = reaperAllowedInEnv({ EXECUTION_ENV: "staging" });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("staging");
  });

  it("staging reaper stays off even with a partial vendor cred set", () => {
    expect(reaperAllowedInEnv({ EXECUTION_ENV: "staging", STAGING_RENDER_API_KEY: "x" }).allowed).toBe(false);
  });
});
