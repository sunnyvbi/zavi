
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  getAppSetting: vi.fn(),
  logEvent: vi.fn(async () => undefined),
}));
vi.mock("@/services/settings", () => ({ getAppSetting: h.getAppSetting }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: h.logEvent }));

import {
  isProductBuilderEnabled,
  readProductBuilderGate,
  ProductBuilderUnavailable,
  isProductBuilderUnavailable,
} from "../product-builder-flag";

beforeEach(() => {
  h.getAppSetting.mockReset();
  h.logEvent.mockClear();
  delete process.env.PRODUCT_BUILDER_ENABLED;
});
afterEach(() => {
  delete process.env.PRODUCT_BUILDER_ENABLED;
});

describe("product builder switch", () => {
  it("reads the setting strictly (a read error must throw, not fall back)", async () => {
    h.getAppSetting.mockResolvedValue(true);
    await isProductBuilderEnabled();
    expect(h.getAppSetting).toHaveBeenCalledWith("product_builder_enabled", null, { strict: true });
  });

  it("stored true / false win; unset falls back to the env, default on", async () => {
    h.getAppSetting.mockResolvedValue(true);
    expect(await isProductBuilderEnabled()).toBe(true);
    h.getAppSetting.mockResolvedValue(false);
    expect(await isProductBuilderEnabled()).toBe(false);
    h.getAppSetting.mockResolvedValue(undefined);
    expect(await isProductBuilderEnabled()).toBe(true);
    process.env.PRODUCT_BUILDER_ENABLED = "0";
    expect(await isProductBuilderEnabled()).toBe(false);
  });

  it("an unreadable setting is NOT on: it throws the typed retryable refusal and logs an error event", async () => {
    process.env.PRODUCT_BUILDER_ENABLED = "1";
    h.getAppSetting.mockRejectedValue(new Error("app_setting read failed: timeout"));
    const err = await isProductBuilderEnabled().catch((e) => e);
    expect(err).toBeInstanceOf(ProductBuilderUnavailable);
    expect(isProductBuilderUnavailable(err)).toBe(true);
    expect(err.retryable).toBe(true);
    expect(err.status).toBe(503);
    expect(err.message).toMatch(/paused right now/);
    expect(h.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ level: "error", code: "product_builder_flag_read_failed" }),
    );
    expect(await readProductBuilderGate()).toBe("unavailable");
  });
});
