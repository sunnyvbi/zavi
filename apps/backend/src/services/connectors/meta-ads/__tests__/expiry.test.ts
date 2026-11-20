
import { describe, it, expect, vi, beforeEach } from "vitest";

const debugTokenMock = vi.fn();
vi.mock("../oauth", () => ({ debugToken: (t: string) => debugTokenMock(t) }));

const rpcMock = vi.fn(async (_fn: string, _args: unknown) => ({
  error: null as { message: string } | null,
}));
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({ rpc: rpcMock }) }));

const logMock = vi.fn(async (_e: unknown) => {});
vi.mock("@/services/logging/logEvent", () => ({ logEvent: (e: unknown) => logMock(e) }));

import { resolveTokenExpiry, persistMetaAdsExpiry } from "../expiry";

const TENANT = "22222222-2222-2222-2222-222222222222";
const DAY = 86400 * 1000;

beforeEach(() => {
  debugTokenMock.mockReset();
  rpcMock.mockReset().mockResolvedValue({ error: null });
  logMock.mockReset();
});

describe("resolveTokenExpiry", () => {
  it("prefers Meta's authoritative /debug_token expiry over expires_in", async () => {
    const authoritative = new Date(Date.now() + 47 * DAY);
    debugTokenMock.mockResolvedValue({ is_valid: true, expires_at: authoritative });
    const got = await resolveTokenExpiry("tok", 60 * 86400, TENANT);
    expect(got.getTime()).toBe(authoritative.getTime());
  });

  it("falls back to expires_in when debug_token throws (connect must not fail)", async () => {
    debugTokenMock.mockRejectedValue(new Error("graph 500"));
    const got = await resolveTokenExpiry("tok", 3600, TENANT);
    expect(got.getTime()).toBeGreaterThan(Date.now() + 3000 * 1000);
    expect(got.getTime()).toBeLessThan(Date.now() + 4000 * 1000);
  });

  it("falls back to 60d and LOGS when neither source yields an expiry", async () => {
    debugTokenMock.mockResolvedValue({ is_valid: false, expires_at: null });
    const got = await resolveTokenExpiry("tok", undefined, TENANT);
    expect(got.getTime()).toBeGreaterThan(Date.now() + 59 * DAY);
    expect(logMock).toHaveBeenCalledWith(
      expect.objectContaining({ code: "meta_ads.expires_in_missing" }),
    );
  });

  it("treats a valid token with no expiry (system-user) as far-future, not NULL", async () => {
    debugTokenMock.mockResolvedValue({ is_valid: true, expires_at: null });
    const got = await resolveTokenExpiry("tok", undefined, TENANT);
    expect(got.getTime()).toBeGreaterThan(Date.now() + 59 * DAY);
    expect(logMock).not.toHaveBeenCalled();
  });
});

describe("persistMetaAdsExpiry", () => {
  it("calls refresh_connector_secrets with the exact named args + slug-prefixed key", async () => {
    const exp = new Date(Date.now() + 60 * DAY);
    const ok = await persistMetaAdsExpiry({
      tenant_id: TENANT,
      access_token: "tok-abc",
      expires_at: exp,
    });
    expect(ok).toBe(true);
    expect(rpcMock).toHaveBeenCalledWith("refresh_connector_secrets", {
      p_tenant_id: TENANT,
      p_slug: "meta_ads",
      p_secrets: { "meta_ads.access_token": "tok-abc" },
      p_expires_at: exp.toISOString(),
    });
  });

  it("returns false and logs on RPC failure (caller must not claim success)", async () => {
    rpcMock.mockResolvedValue({ error: { message: "boom" } });
    const ok = await persistMetaAdsExpiry({
      tenant_id: TENANT,
      access_token: "tok",
      expires_at: new Date(),
    });
    expect(ok).toBe(false);
    expect(logMock).toHaveBeenCalledWith(
      expect.objectContaining({ code: "meta_ads.expiry_persist_failed", level: "error" }),
    );
  });
});
