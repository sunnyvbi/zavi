
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getCachedTenant,
  setCachedTenant,
  invalidateCachedTenant,
  _clearTenantCacheForTests,
} from "../tenant-cache";

beforeEach(() => _clearTenantCacheForTests());
afterEach(() => {
  vi.useRealTimers();
});

describe("tenant-cache", () => {
  it("returns null on a miss", () => {
    expect(getCachedTenant("nobody", "s1")).toBeNull();
  });

  it("returns the cached tenant on a hit", () => {
    setCachedTenant("u1", "s1", "t1");
    expect(getCachedTenant("u1", "s1")).toBe("t1");
  });

  it("invalidate drops the entry (switch/revoke reflect immediately)", () => {
    setCachedTenant("u1", "s1", "t1");
    invalidateCachedTenant("u1");
    expect(getCachedTenant("u1", "s1")).toBeNull();
  });

  it("isolates users — one entry never answers for another", () => {
    setCachedTenant("u1", "s1", "t1");
    expect(getCachedTenant("u2", "s2")).toBeNull();
  });

  it("isolates SESSIONS of the same user — browser A's tenant never answers for browser B", () => {
    setCachedTenant("u1", "sessionA", "tenant-A");
    setCachedTenant("u1", "sessionB", "tenant-B");

    expect(getCachedTenant("u1", "sessionA")).toBe("tenant-A");
    expect(getCachedTenant("u1", "sessionB")).toBe("tenant-B");
  });

  it("a session with no entry misses even when a sibling session of the same user is cached", () => {
    setCachedTenant("u1", "sessionA", "tenant-A");
    expect(getCachedTenant("u1", "sessionB")).toBeNull();
  });

  it("invalidate drops EVERY session of that user, not just one", () => {
    setCachedTenant("u1", "sessionA", "tenant-A");
    setCachedTenant("u1", "sessionB", "tenant-B");
    setCachedTenant("u2", "sessionC", "tenant-C");

    invalidateCachedTenant("u1");

    expect(getCachedTenant("u1", "sessionA")).toBeNull();
    expect(getCachedTenant("u1", "sessionB")).toBeNull();
    expect(getCachedTenant("u2", "sessionC")).toBe("tenant-C");
  });

  it("sessionless tokens share a user-scoped entry, distinct from session entries", () => {
    setCachedTenant("u1", null, "default-tenant");
    setCachedTenant("u1", "sessionA", "tenant-A");

    expect(getCachedTenant("u1", null)).toBe("default-tenant");
    expect(getCachedTenant("u1", "sessionA")).toBe("tenant-A");
  });

  it("expires after the 30s TTL", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-03T00:00:00Z"));
    setCachedTenant("u1", "s1", "t1");
    expect(getCachedTenant("u1", "s1")).toBe("t1");

    vi.setSystemTime(new Date("2026-06-03T00:00:29Z"));
    expect(getCachedTenant("u1", "s1")).toBe("t1");

    vi.setSystemTime(new Date("2026-06-03T00:00:31Z"));
    expect(getCachedTenant("u1", "s1")).toBeNull();
  });

  it("re-setting refreshes the TTL window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-03T00:00:00Z"));
    setCachedTenant("u1", "s1", "t1");
    vi.setSystemTime(new Date("2026-06-03T00:00:20Z"));
    setCachedTenant("u1", "s1", "t1");
    vi.setSystemTime(new Date("2026-06-03T00:00:45Z"));
    expect(getCachedTenant("u1", "s1")).toBe("t1");
  });
});
