
import { describe, it, expect } from "vitest";
import { realConductorTickDeps } from "../conductor-driver";

describe("realConductorTickDeps.siteDeploy", () => {
  it("is wired (step / headSha / markDesired / settle / repairMaxAttempts)", () => {
    const sd = realConductorTickDeps.siteDeploy!;
    expect(sd).toBeDefined();
    for (const k of ["step", "headSha", "markDesired", "settle", "repairMaxAttempts"] as const) {
      expect(typeof sd[k]).toBe("function");
    }
  });
});
