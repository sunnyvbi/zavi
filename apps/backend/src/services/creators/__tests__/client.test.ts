
import { afterEach, describe, expect, it } from "vitest";
import { ExpectedToolError } from "@/services/tools/types";
import { _resetPlatformClient } from "@/services/tools/stripe/_platform-client";
import {
  assertLivemodeMatchesKey,
  creatorPaymentsEnabled,
  creatorStripeClient,
  platformKeyLivemode,
} from "../client";

const ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ENV };
  _resetPlatformClient();
});

describe("creatorPaymentsEnabled (T5)", () => {
  it("is ON by default (spec Q32: on for every business)", () => {
    delete process.env.CREATOR_PAYMENTS_ENABLED;
    expect(creatorPaymentsEnabled()).toBe(true);
  });

  it('is OFF only when explicitly "0"', () => {
    process.env.CREATOR_PAYMENTS_ENABLED = "0";
    expect(creatorPaymentsEnabled()).toBe(false);
    process.env.CREATOR_PAYMENTS_ENABLED = "1";
    expect(creatorPaymentsEnabled()).toBe(true);
  });

  it("does not read STRIPE_PROVISIONING_ENABLED: the autopilot rail can be off while creator payments are on", () => {
    process.env.STRIPE_PLATFORM_SECRET_KEY = "sk_test_fake";
    process.env.STRIPE_PROVISIONING_ENABLED = "0";
    delete process.env.CREATOR_PAYMENTS_ENABLED;
    expect(() => creatorStripeClient()).not.toThrow();
  });

  it("refuses when the creator switch is off, even with the autopilot rail armed", () => {
    process.env.STRIPE_PLATFORM_SECRET_KEY = "sk_test_fake";
    process.env.STRIPE_PROVISIONING_ENABLED = "1";
    process.env.CREATOR_PAYMENTS_ENABLED = "0";
    expect(() => creatorStripeClient()).toThrowError(ExpectedToolError);
  });

  it("refuses with no platform key at all", () => {
    delete process.env.STRIPE_PLATFORM_SECRET_KEY;
    expect(() => creatorStripeClient()).toThrowError(/not set/);
  });
});

describe("livemode boundary", () => {
  it.each([
    ["sk_test_abc", false],
    ["rk_test_abc", false],
    ["sk_live_abc", true],
    ["rk_live_abc", true],
  ])("reads %s as livemode=%s", (key, expected) => {
    expect(platformKeyLivemode(key)).toBe(expected);
  });

  it("refuses a key whose mode it cannot read, rather than assuming test", () => {
    expect(() => platformKeyLivemode("sk_whatever")).toThrowError(/test or live/);
  });

  it("refuses a missing key", () => {
    expect(() => platformKeyLivemode(null)).toThrowError(/not set/);
  });

  it.each([
    [false, "sk_test_abc"],
    [true, "sk_live_abc"],
  ])("allows a livemode=%s row under the matching key", (rowLive, key) => {
    expect(() => assertLivemodeMatchesKey(rowLive, key)).not.toThrow();
  });

  it.each([
    [true, "sk_test_abc"],
    [false, "sk_live_abc"],
  ])("refuses a livemode=%s row under %s", (rowLive, key) => {
    expect(() => assertLivemodeMatchesKey(rowLive, key)).toThrowError(/boundary/);
  });
});
