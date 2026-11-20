import { describe, it, expect } from "vitest";
import { parseSendError } from "./chatSendError";

describe("parseSendError (chat send error body)", () => {
  it("extracts code + message from a structured insufficient_credits body", () => {
    const body = JSON.stringify({
      error: { code: "insufficient_credits", message: "You're out of credits. Top up in Billing." },
    });
    expect(parseSendError(body)).toEqual({
      code: "insufficient_credits",
      message: "You're out of credits. Top up in Billing.",
      required_tier: null,
    });
  });

  it("returns code with null message when message is absent", () => {
    const body = JSON.stringify({ error: { code: "thread_not_found" } });
    expect(parseSendError(body)).toEqual({ code: "thread_not_found", message: null, required_tier: null });
  });

  it("returns nulls for a non-JSON body (caller falls back to raw text)", () => {
    expect(parseSendError("502 Bad Gateway")).toEqual({ code: null, message: null, required_tier: null });
    expect(parseSendError("")).toEqual({ code: null, message: null, required_tier: null });
  });

  it("ignores a non-string message (never leaks a non-string into the banner)", () => {
    const body = JSON.stringify({ error: { code: "x", message: { nested: true } } });
    expect(parseSendError(body)).toEqual({ code: "x", message: null, required_tier: null });
  });

  it("reads required_tier off a plan_upgrade_required body", () => {
    const body = JSON.stringify({
      error: { code: "plan_upgrade_required", required_tier: "starter", message: "Instagram needs the Starter plan ($20/mo)." },
    });
    expect(parseSendError(body).required_tier).toBe("starter");
  });
});
