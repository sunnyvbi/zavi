
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/services/tenant-client", () => ({ platformSecretRpc: vi.fn() }));

import { deriveVerifier, callbackUrl } from "../oauth";

beforeEach(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-server-secret-value";
});

describe("deriveVerifier", () => {
  it("is deterministic — the callback recomputes what the start minted", () => {
    const state = "abc123state";
    expect(deriveVerifier(state)).toBe(deriveVerifier(state));
  });

  it("is unique per state, so one nonce cannot unlock another's exchange", () => {
    expect(deriveVerifier("state-one")).not.toBe(deriveVerifier("state-two"));
  });

  it("changes with the server secret — it is not derivable from the state alone", () => {
    const a = deriveVerifier("same-state");
    process.env.SUPABASE_SERVICE_ROLE_KEY = "a-different-server-secret";
    expect(deriveVerifier("same-state")).not.toBe(a);
  });

  it("refuses to derive when no server secret is configured", () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.INNGEST_SIGNING_KEY;
    expect(() => deriveVerifier("s")).toThrow(/server secret/i);
  });

  it("produces a PKCE-legal verifier (43-128 unreserved chars)", () => {
    const v = deriveVerifier("abc");
    expect(v.length).toBeGreaterThanOrEqual(43);
    expect(v.length).toBeLessThanOrEqual(128);
    expect(v).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });
});

describe("callbackUrl", () => {
  it("is absolute https so the vendor can reach it", () => {
    delete process.env.BACKEND_PUBLIC_URL;
    expect(callbackUrl()).toBe("https://api.zaviagent.com/api/connectors/higgsfield/callback");
  });

  it("honours BACKEND_PUBLIC_URL without doubling the slash", () => {
    process.env.BACKEND_PUBLIC_URL = "https://api.example.com/";
    expect(callbackUrl()).toBe("https://api.example.com/api/connectors/higgsfield/callback");
  });
});
