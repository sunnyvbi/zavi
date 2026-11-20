import { describe, it, expect, vi, beforeEach } from "vitest";

const sb = vi.hoisted(() => ({ result: { data: null as unknown, error: null as unknown } }));
vi.mock("@/services/tenant-client", () => ({
  globalClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => sb.result }) }) }),
  }),
}));
vi.mock("@/services/channels/lock", () => ({ isChannelLocked: vi.fn(async () => false), isChannelLockedStrict: vi.fn(async () => false) }));
vi.mock("@/services/tools/google-ads/write/_flag-check", () => ({ isGoogleAdsWriteEnabled: vi.fn(async () => true) }));
vi.mock("@/services/tools/meta-ads/write/_flag-check", () => ({ isMetaAdsWriteEnabled: vi.fn(async () => true) }));

import { execPlatformLabel, platformWriteEnabled } from "../exec-kill-switch";

beforeEach(() => {
  sb.result = { data: null, error: null };
});

describe("creator hire kill switch", () => {
  it("creator.hire has its own entry, not the allow-unknown default", () => {
    expect(execPlatformLabel("creator.hire")).toBe("Creator hire");
  });
  it("is OFF by default: no config row, or a blob without the flag", async () => {
    expect(await platformWriteEnabled("creator.hire")).toBe(false);
    sb.result = { data: { blob: {} }, error: null };
    expect(await platformWriteEnabled("creator.hire")).toBe(false);
    sb.result = { data: { blob: { creator_hires_enabled: "true" } }, error: null };
    expect(await platformWriteEnabled("creator.hire")).toBe(false);
  });
  it("is ON only when explicitly true", async () => {
    sb.result = { data: { blob: { creator_hires_enabled: true } }, error: null };
    expect(await platformWriteEnabled("creator.hire")).toBe(true);
  });
  it("an unreadable config means off", async () => {
    sb.result = { data: null, error: { message: "boom" } };
    expect(await platformWriteEnabled("creator.hire")).toBe(false);
  });
});
