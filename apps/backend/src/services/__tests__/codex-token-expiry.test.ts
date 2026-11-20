
import { describe, it, expect, afterEach } from "vitest";
import {
  codexTokenExpiryEpoch,
  codexTokenDaysLeft,
  getCodexClient,
  __resetCodexClientForTests,
} from "@/services/codex-subscription";

function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64(payload)}.sig`;
}

describe("codexTokenExpiryEpoch", () => {
  it("reads exp out of the token", () => {
    expect(codexTokenExpiryEpoch(jwt({ exp: 1788527834 }))).toBe(1788527834);
  });

  it("returns null for unset / non-JWT / malformed / exp-less tokens", () => {
    expect(codexTokenExpiryEpoch(undefined)).toBeNull();
    expect(codexTokenExpiryEpoch("   ")).toBeNull();
    expect(codexTokenExpiryEpoch("not-a-jwt")).toBeNull();
    expect(codexTokenExpiryEpoch("a.b.c")).toBeNull();
    expect(codexTokenExpiryEpoch(jwt({ sub: "x" }))).toBeNull();
  });
});

describe("codexTokenDaysLeft", () => {
  const saved = process.env.CODEX_ACCESS_TOKEN;
  const now = 1_788_000_000_000;

  it("counts down, and goes negative once expired", () => {
    process.env.CODEX_ACCESS_TOKEN = jwt({ exp: now / 1000 + 86_400 * 3 });
    expect(codexTokenDaysLeft(now)).toBeCloseTo(3, 5);

    process.env.CODEX_ACCESS_TOKEN = jwt({ exp: now / 1000 - 86_400 });
    expect(codexTokenDaysLeft(now)).toBeCloseTo(-1, 5);

    if (saved === undefined) delete process.env.CODEX_ACCESS_TOKEN;
    else process.env.CODEX_ACCESS_TOKEN = saved;
  });
});

describe("getCodexClient — expiry gate", () => {
  const saved = process.env.CODEX_ACCESS_TOKEN;
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const tok = (secondsFromNow: number) =>
    `${b64({ alg: "RS256" })}.${b64({ exp: Math.floor(Date.now() / 1000) + secondsFromNow })}.sig`;

  afterEach(() => {
    __resetCodexClientForTests();
    if (saved === undefined) delete process.env.CODEX_ACCESS_TOKEN;
    else process.env.CODEX_ACCESS_TOKEN = saved;
  });

  it("returns null for an EXPIRED token — same degrade path as an unset one", () => {
    process.env.CODEX_ACCESS_TOKEN = tok(-3600);
    expect(getCodexClient()).toBeNull();
  });

  it("returns a client while the token is still live", () => {
    process.env.CODEX_ACCESS_TOKEN = tok(86_400 * 5);
    expect(getCodexClient()).not.toBeNull();
  });

  it("stops handing out the memoized client once the token lapses mid-process", () => {
    process.env.CODEX_ACCESS_TOKEN = tok(86_400 * 5);
    expect(getCodexClient()).not.toBeNull();
    process.env.CODEX_ACCESS_TOKEN = tok(-60);
    expect(getCodexClient()).toBeNull();
  });

  it("leaves a non-JWT token alone — unreadable expiry is not proof of expiry", () => {
    process.env.CODEX_ACCESS_TOKEN = "opaque-not-a-jwt";
    expect(getCodexClient()).not.toBeNull();
  });
});
