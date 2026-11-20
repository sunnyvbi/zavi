import { describe, it, expect } from "vitest";
import { isAuthOutage, authFailureMessage, AUTH_OUTAGE_MESSAGE } from "./authOutage";

describe("isAuthOutage", () => {
  it("recognises outage-shaped auth errors", () => {
    for (const m of [
      "request timed out after 20000ms",
      "Failed to fetch",
      "TypeError: NetworkError when attempting to fetch resource.",
      "Load failed",
      "The operation was aborted.",
      "503 Service Unavailable",
      "error code: 522",
      "Bad Gateway",
    ]) expect(isAuthOutage(m), m).toBe(true);
  });
  it("leaves the person's own mistakes alone", () => {
    for (const m of ["Invalid login credentials", "User already registered", "Password should be at least 8 characters", "Email not confirmed"])
      expect(isAuthOutage(m), m).toBe(false);
  });

  it("a 5xx status is an outage whatever the body says; a 4xx keeps its message", () => {
    expect(authFailureMessage("Could not send code. Try again in a moment.", 500)).toBe(AUTH_OUTAGE_MESSAGE);
    expect(authFailureMessage("database connection failed", 503)).toBe(AUTH_OUTAGE_MESSAGE);
    expect(authFailureMessage("Invalid login credentials", 400)).toBe("Invalid login credentials");
    expect(authFailureMessage("Token has expired or is invalid", undefined)).toBe("Token has expired or is invalid");
  });
});
