
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import {
  xSocialAuthorizeUrl,
  pkceVerifierFor,
  pkceChallengeFor,
  xSocialExchangeCode,
} from "../oauth";

const ENV = ["X_SOCIAL_CLIENT_ID", "X_SOCIAL_CLIENT_SECRET", "OAUTH_STATE_SECRET"] as const;
const prev: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV) prev[k] = process.env[k];
  process.env.X_SOCIAL_CLIENT_ID = "x-client";
  process.env.X_SOCIAL_CLIENT_SECRET = "x-secret";
  process.env.OAUTH_STATE_SECRET = "test-state-secret";
});
afterEach(() => {
  for (const k of ENV) {
    if (prev[k] === undefined) delete process.env[k];
    else process.env[k] = prev[k];
  }
});

describe("PKCE derivation", () => {
  it("is deterministic for the same state and differs across states", () => {
    expect(pkceVerifierFor("s1")).toBe(pkceVerifierFor("s1"));
    expect(pkceVerifierFor("s1")).not.toBe(pkceVerifierFor("s2"));
  });

  it("is bound to the server secret — a different secret yields a different verifier", () => {
    const a = pkceVerifierFor("s1");
    process.env.OAUTH_STATE_SECRET = "other";
    expect(pkceVerifierFor("s1")).not.toBe(a);
  });

  it("challenge is base64url(SHA-256(verifier)) — the S256 method", () => {
    const v = pkceVerifierFor("s1");
    expect(pkceChallengeFor(v)).toBe(createHash("sha256").update(v).digest("base64url"));
  });

  it("verifier is 43 URL-safe chars (RFC 7636 length + alphabet)", () => {
    const v = pkceVerifierFor("abc");
    expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("xSocialAuthorizeUrl", () => {
  it("requests tweet.write + offline.access with an S256 challenge bound to the state", () => {
    const url = new URL(xSocialAuthorizeUrl("state-xyz", "https://api.example/cb"));
    expect(url.origin + url.pathname).toBe("https://x.com/i/oauth2/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("x-client");
    expect(url.searchParams.get("redirect_uri")).toBe("https://api.example/cb");
    expect(url.searchParams.get("state")).toBe("state-xyz");
    const scope = url.searchParams.get("scope") ?? "";
    for (const s of ["tweet.read", "tweet.write", "users.read", "offline.access"]) expect(scope).toContain(s);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(pkceChallengeFor(pkceVerifierFor("state-xyz")));
  });
});

describe("xSocialExchangeCode", () => {
  it("refuses without the raw state — PKCE cannot complete", async () => {
    await expect(xSocialExchangeCode("code", "https://api.example/cb")).rejects.toThrow(/raw OAuth state/);
  });
});
