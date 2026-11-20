import { describe, it, expect, beforeEach } from "vitest";
import {
  isConnectionFailure,
  unreachableMessage,
  rememberUnreachable,
  recallUnreachable,
  forgetUnreachable,
  __resetReachability,
  UNREACHABLE_MEMO_MS,
} from "../direct/reachability";
import { DatabaseUnreachableError } from "../types";

function named(name: string, message = "x", code?: string): Error {
  const e = new Error(message) as Error & { code?: string };
  e.name = name;
  if (code) e.code = code;
  return e;
}

describe("isConnectionFailure", () => {
  it("is true for a Mongo server-selection timeout", () => {
    expect(isConnectionFailure(named("MongoServerSelectionError", "Server selection timed out after 8000 ms"))).toBe(true);
  });
  it("is true for network errors by code (pg, mysql)", () => {
    for (const code of ["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN"]) {
      expect(isConnectionFailure(named("Error", "connect failed", code))).toBe(true);
    }
  });
  it("is false for a reset socket (a TLS mismatch resets it too)", () => {
    expect(isConnectionFailure(named("Error", "socket hang up", "ECONNRESET"))).toBe(false);
  });
  it("is true for the pg connect timeout", () => {
    expect(isConnectionFailure(new Error("timeout expired"))).toBe(true);
    expect(isConnectionFailure(new Error("Connection terminated due to connection timeout"))).toBe(true);
  });
  it("is false for a bad password, a bad query and a guard refusal", () => {
    expect(isConnectionFailure(named("MongoServerSelectionError", "bad auth : authentication failed"))).toBe(false);
    expect(isConnectionFailure(named("MongoServerError", "unknown top level operator: $nope"))).toBe(false);
    expect(isConnectionFailure(new Error('password authentication failed for user "x"'))).toBe(false);
    expect(isConnectionFailure(null)).toBe(false);
  });
});

describe("unreachableMessage", () => {
  it("names the last good read, the IPs, and says not to retry", () => {
    const m = unreachableMessage({ lastReadAt: "2026-10-17T21:09:10Z", ips: ["203.0.113.10", "203.0.113.11"] });
    expect(m).toContain("Oct 17");
    expect(m).toContain("203.0.113.10, 203.0.113.11");
    expect(m).toMatch(/do not retry/i);
    expect(m).toMatch(/never tell them to ask again in a few minutes/i);
    expect(m).not.toContain("—");
  });
  it("drops the IP list when none are configured and the date when there was never a good read", () => {
    const m = unreachableMessage({ lastReadAt: null, ips: [] });
    expect(m).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
    expect(m).not.toMatch(/last read it successfully/);
  });
});

describe("2-minute memo", () => {
  beforeEach(() => __resetReachability());
  it("recalls within the window on the same generation, not after", () => {
    rememberUnreachable("t1", 4, "msg", 1_000);
    expect(recallUnreachable("t1", 4, 1_000 + UNREACHABLE_MEMO_MS - 1)?.message).toBe("msg");
    expect(recallUnreachable("t1", 4, 1_000 + UNREACHABLE_MEMO_MS + 1)).toBeNull();
  });
  it("a new generation (reconnect) is never blocked by the old memo", () => {
    rememberUnreachable("t1", 4, "msg", 1_000);
    expect(recallUnreachable("t1", 5, 1_001)).toBeNull();
  });
  it("is per tenant", () => {
    rememberUnreachable("t1", 4, "msg", 1_000);
    expect(recallUnreachable("t2", 4, 1_001)).toBeNull();
  });
  it("forget clears it", () => {
    rememberUnreachable("t1", 4, "msg", 1_000);
    forgetUnreachable("t1");
    expect(recallUnreachable("t1", 4, 1_001)).toBeNull();
  });
});

describe("DatabaseUnreachableError", () => {
  it("is an expected tool error with its own code", () => {
    const e = new DatabaseUnreachableError("m");
    expect(e.code).toBe("operator_db_unreachable");
    expect(e.message).toBe("m");
  });
});
