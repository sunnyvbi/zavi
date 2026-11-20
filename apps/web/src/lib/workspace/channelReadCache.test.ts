// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tenant = vi.hoisted(() => ({ id: "tenant-a" as string | null }));
vi.mock("./sessionScopedCache", () => ({ registerSessionScopedCache: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({}) }));
vi.mock("@/lib/active-tenant-client", () => ({ getActiveTenantId: async () => tenant.id }));

import {
  CHANNEL_READ_MAX_AGE_MS,
  channelCacheAge,
  clearChannelReadCache,
  endChannelReadCache,
  readChannelCache,
  readChannelCacheEntry,
  writeChannelCache,
} from "./channelReadCache";
import { registerSessionScopedCache } from "./sessionScopedCache";
import { TENANT_SWITCH_EVENT } from "./tenantSwitch";

const STORED = "zavi:channel-read:v1:";
const settle = () => new Promise((r) => setTimeout(r, 0));

async function loadPageAs(id: string | null) {
  tenant.id = id;
  const keep: Array<[string, string]> = [];
  for (let i = 0; i < window.sessionStorage.length; i++) {
    const k = window.sessionStorage.key(i)!;
    keep.push([k, window.sessionStorage.getItem(k)!]);
  }
  clearChannelReadCache();
  for (const [k, v] of keep) window.sessionStorage.setItem(k, v);
  readChannelCache("warm-up");
  await settle();
}

beforeEach(async () => {
  window.sessionStorage.clear();
  await loadPageAs("tenant-a");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("channelReadCache", () => {
  it("returns what was written with when it was read, and misses on an unknown key", () => {
    writeChannelCache("dash:meta_ads:", { spend: 12 });
    expect(readChannelCacheEntry("dash:meta_ads:")).toEqual({ data: { spend: 12 }, at: expect.any(Number) });
    expect(readChannelCache("dash:google_ads:")).toBeNull();
  });

  it("puts the tenant id in every stored key", () => {
    writeChannelCache("history:reddit", { runs: [] });
    expect(window.sessionStorage.getItem(`${STORED}tenant-a:history:reddit`)).not.toBeNull();
  });

  it("survives a reload under the same tenant", async () => {
    writeChannelCache("history:reddit", { runs: [1] });
    await loadPageAs("tenant-a");
    expect(readChannelCache("history:reddit")).toEqual({ runs: [1] });
  });

  it("never shows one tenant's answer to another, and deletes it", async () => {
    writeChannelCache("ad-locations:meta_ads", { state: "saved" });
    await loadPageAs("tenant-b");
    expect(readChannelCache("ad-locations:meta_ads")).toBeNull();
    expect(window.sessionStorage.getItem(`${STORED}tenant-a:ad-locations:meta_ads`)).toBeNull();
    expect(window.sessionStorage.getItem(`${STORED}__tenant`)).toBe("tenant-b");
  });

  it("caches nothing while the tenant is unknown, and asks again later", async () => {
    window.sessionStorage.setItem(`${STORED}tenant-a:dash:x:`, JSON.stringify({ data: 1, at: Date.now() }));
    await loadPageAs(null);
    expect(readChannelCache("dash:x:")).toBeNull();
    writeChannelCache("dash:y:", 2);
    expect(readChannelCache("dash:y:")).toBeNull();
    await settle();

    tenant.id = "tenant-a";
    readChannelCache("dash:x:");
    await settle();
    expect(readChannelCache("dash:x:")).toBe(1);
  });

  it("is wiped when a company switch starts", () => {
    writeChannelCache("metrics:x", [1]);
    window.dispatchEvent(new Event(TENANT_SWITCH_EVENT));
    expect(readChannelCache("metrics:x")).toBeNull();
    expect(window.sessionStorage.getItem(`${STORED}tenant-a:metrics:x`)).toBeNull();
  });

  it("does not paint an answer older than the max age", () => {
    vi.useFakeTimers();
    writeChannelCache("metrics:x", [1, 2]);
    vi.advanceTimersByTime(CHANNEL_READ_MAX_AGE_MS + 1);
    expect(readChannelCache("metrics:x")).toBeNull();
    expect(channelCacheAge("metrics:x")).toBeGreaterThan(CHANNEL_READ_MAX_AGE_MS);
  });

  it("keeps an oversized payload in memory only", () => {
    const big = "x".repeat(500_000);
    writeChannelCache("dash:big:", big);
    expect(readChannelCache("dash:big:")).toBe(big);
    expect(window.sessionStorage.getItem(`${STORED}tenant-a:dash:big:`)).toBeNull();
  });

  it("treats a corrupt stored entry as a miss", () => {
    window.sessionStorage.setItem(`${STORED}tenant-a:dash:bad:`, "{not json");
    expect(readChannelCache("dash:bad:")).toBeNull();
  });

  it("registers itself to be wiped on sign-out", () => {
    expect(registerSessionScopedCache).toHaveBeenCalledWith(endChannelReadCache);
  });

  it("stores nothing after a sign-out, even once the old tenant would resolve again", async () => {
    endChannelReadCache();
    writeChannelCache("history:reddit", { runs: ["theirs"] });
    await settle();
    writeChannelCache("history:reddit", { runs: ["theirs"] });
    expect(readChannelCache("history:reddit")).toBeNull();
    expect(window.sessionStorage.getItem(`${STORED}tenant-a:history:reddit`)).toBeNull();
  });
});
