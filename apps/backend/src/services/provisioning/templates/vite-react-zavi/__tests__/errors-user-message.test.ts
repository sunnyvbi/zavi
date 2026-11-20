import { describe, expect, it } from "vitest";
import { ZaviError, needsSignIn, userMessage } from "../files/src/zavi/errors";

describe("userMessage", () => {
  it("a field the visitor may not write is not a sign-in problem", () => {
    const e = new ZaviError("not_allowed", "you may not set status", { reason: "field_not_writable: status", status: 403 });
    expect(needsSignIn(e)).toBe(false);
    expect(userMessage(e)).not.toMatch(/sign in/i);
  });

  it("a rule that leaves a signed-in visitor out is not a sign-in problem either", () => {
    expect(userMessage(new ZaviError("not_allowed", "forbidden", { reason: "forbidden", status: 403 }))).not.toMatch(/sign in/i);
  });

  it("a missing or expired sign-in asks for one", () => {
    for (const e of [
      new ZaviError("not_allowed", "x", { reason: "signed_out", status: 401 }),
      new ZaviError("not_allowed", "x", { reason: "session_expired", status: 401 }),
      new ZaviError("not_allowed", "x", { status: 401 }),
    ]) {
      expect(needsSignIn(e)).toBe(true);
      expect(userMessage(e)).toMatch(/sign in/i);
    }
  });

  it("a full booking and other codes read plainly", () => {
    expect(userMessage(new ZaviError("conflict", "x", { reason: "action_bound" }))).toMatch(/fully booked/);
    expect(userMessage(new ZaviError("offline", "x"))).toMatch(/offline/);
    expect(userMessage(new Error("boom"))).toMatch(/try again/i);
  });

  it("a signed-out visitor who fails or skips the human check is asked to redo it, never to contact the owner", () => {
    for (const reason of ["turnstile_required", "turnstile_failed", "turnstile_expired"]) {
      const e = new ZaviError("not_allowed", reason, { reason, status: 403, signedOut: true });
      expect(needsSignIn(e)).toBe(false);
      expect(userMessage(e)).toBe("Complete the check above, then try again.");
      expect(userMessage(e)).not.toMatch(/contact us|can't be saved/i);
    }
  });
});
