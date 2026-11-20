import { describe, it, expect } from "vitest";
import { floorReplyBody, CHAT_EMPTY_FALLBACK } from "../chat-reply-text";

describe("floorReplyBody — final RPC-boundary non-empty floor", () => {
  it("(a) an empty post-decorator body floors to CHAT_EMPTY_FALLBACK (RPC-safe, never empty)", () => {
    const r = floorReplyBody("");
    expect(r.refloored).toBe(true);
    expect(r.text).toBe(CHAT_EMPTY_FALLBACK);
    expect(r.text.length).toBeGreaterThan(0);
    expect(r.text.slice(0, 32000).trim().length).toBeGreaterThan(0);
  });

  it("(a') a whitespace-only body (format-ask stripped everything) also floors", () => {
    const r = floorReplyBody("   \n\t  \n ");
    expect(r.refloored).toBe(true);
    expect(r.text).toBe(CHAT_EMPTY_FALLBACK);
  });

  it("(b) a normal non-empty body passes through UNCHANGED (no re-floor)", () => {
    const body = "Here are the 3 growth levers I'd pull this week:\n\n1. ...";
    const r = floorReplyBody(body);
    expect(r.refloored).toBe(false);
    expect(r.text).toBe(body);
  });

  it("(b') a body that is only surrounded by whitespace keeps its content", () => {
    const r = floorReplyBody("  real answer  ");
    expect(r.refloored).toBe(false);
    expect(r.text).toBe("  real answer  ");
  });
});
