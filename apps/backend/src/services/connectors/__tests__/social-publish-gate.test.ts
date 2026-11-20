import { describe, it, expect, vi } from "vitest";
import { localOverrideAllows, socialPublishGate } from "../social-publish-gate";

const T = "73db45ff-457e-4541-bc8f-bdb625390204";
const sbWith = (data: unknown, error: { message: string } | null = null) =>
  ({ rpc: vi.fn().mockResolvedValue({ data, error }) }) as never;

describe("socialPublishGate", () => {
  it("config true opens regardless of env", async () => {
    expect(await socialPublishGate(sbWith(true), T, { NODE_ENV: "production" })).toEqual({ open: true, via: "config" });
  });
  it("config false + production NEVER opens, even with the allowlist set", async () => {
    expect(
      await socialPublishGate(sbWith(false), T, { NODE_ENV: "production", SOCIAL_PUBLISH_LOCAL_OVERRIDE_TENANTS: T }),
    ).toEqual({ open: false });
  });
  it("config false + local + tenant allowlisted opens via local_override", async () => {
    expect(await socialPublishGate(sbWith(false), T, { SOCIAL_PUBLISH_LOCAL_OVERRIDE_TENANTS: `x, ${T}` })).toEqual({
      open: true,
      via: "local_override",
    });
  });
  it("config false + local + tenant NOT allowlisted stays closed", async () => {
    expect(await socialPublishGate(sbWith(false), "other", { SOCIAL_PUBLISH_LOCAL_OVERRIDE_TENANTS: T })).toEqual({ open: false });
    expect(await socialPublishGate(sbWith(false), T, {})).toEqual({ open: false });
  });
  it("rpc error closes with the message", async () => {
    expect(await socialPublishGate(sbWith(null, { message: "boom" }), T, {})).toEqual({ open: false, error: "boom" });
  });
  it("localOverrideAllows ignores whitespace and refuses production", () => {
    expect(localOverrideAllows(T, { SOCIAL_PUBLISH_LOCAL_OVERRIDE_TENANTS: ` ${T} ` })).toBe(true);
    expect(localOverrideAllows(T, { NODE_ENV: "production", SOCIAL_PUBLISH_LOCAL_OVERRIDE_TENANTS: T })).toBe(false);
  });
});
