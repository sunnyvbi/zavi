import { describe, it, expect, vi, beforeEach } from "vitest";

const lock = vi.hoisted(() => ({ isChannelLocked: vi.fn(), isChannelLockedStrict: vi.fn() }));
vi.mock("@/services/channels/lock", () => lock);
vi.mock("@/services/tools/google-ads/write/_flag-check", () => ({ isGoogleAdsWriteEnabled: vi.fn(async () => true) }));
vi.mock("@/services/tools/meta-ads/write/_flag-check", () => ({ isMetaAdsWriteEnabled: vi.fn(async () => true) }));

import { platformWriteEnabled } from "../exec-kill-switch";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("generated_video kill switch", () => {
  it("a config read error means disabled (fails closed)", async () => {
    lock.isChannelLockedStrict.mockRejectedValue(new Error("channel lock config unavailable"));
    expect(await platformWriteEnabled("generated_video.render.v1")).toBe(false);
    expect(lock.isChannelLocked).not.toHaveBeenCalled();
  });
  it("locked means disabled, unlocked means enabled", async () => {
    lock.isChannelLockedStrict.mockResolvedValueOnce(true);
    expect(await platformWriteEnabled("generated_video.render.v1")).toBe(false);
    lock.isChannelLockedStrict.mockResolvedValueOnce(false);
    expect(await platformWriteEnabled("generated_video.render.v1")).toBe(true);
  });
});
