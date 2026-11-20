import { describe, expect, it } from "vitest";
import { AuthStepError, authFailedProps } from "./authFailure";

describe("authFailedProps", () => {
  it("reports the provider code and status, never the message", () => {
    const props = authFailedProps(new AuthStepError("Wrong email or password for a@b.com", "invalid_credentials", 400));
    expect(props).toEqual({ reason: "invalid_credentials", status: 400 });
    expect(JSON.stringify(props)).not.toContain("a@b.com");
  });
  it("names a network failure and anything else as unknown", () => {
    expect(authFailedProps(new TypeError("Failed to fetch"))).toEqual({ reason: "network" });
    expect(authFailedProps(new Error("boom"))).toEqual({ reason: "unknown" });
    expect(authFailedProps(new AuthStepError("x"))).toEqual({ reason: "unknown", status: undefined });
  });
});
