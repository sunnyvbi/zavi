import { describe, expect, it } from "vitest";
import { ownSiteBlocksBuild, shouldShowBuilderCard } from "./BuilderChatCard";

type Args = Parameters<typeof shouldShowBuilderCard>[0];

const base: Args = {
  enabled: true,
  buildAppIntent: "fresh",
  buildStatus: "none",
  productUrl: { status: "ok", value: {} },
};
const OWN_SITE = {
  status: "ok" as const,
  value: { marketing: "https://www.upcar.ai" },
};
const show = (over: Partial<Args>) => shouldShowBuilderCard({ ...base, ...over });

describe("shouldShowBuilderCard", () => {
  it("shows for a fresh-intent tenant with no product of their own", () => {
    expect(show({})).toBe(true);
  });

  it("hides when the feature flag is off", () => {
    expect(show({ enabled: false })).toBe(false);
  });

  it("hides when the tenant did not pick the build door", () => {
    expect(show({ buildAppIntent: "existing" })).toBe(false);
    expect(show({ buildAppIntent: "" })).toBe(false);
  });

  it("hides from a tenant who already runs their own site", () => {
    expect(show({ productUrl: OWN_SITE, buildStatus: "none" })).toBe(false);
    expect(show({ productUrl: OWN_SITE, buildStatus: "failed" })).toBe(false);
  });

  it("still shows to an own-site tenant while a build is IN FLIGHT", () => {
    expect(show({ productUrl: OWN_SITE, buildStatus: "building" })).toBe(true);
  });

  it("still shows to an own-site tenant whose Zavi-built app is LIVE", () => {
    expect(show({ productUrl: OWN_SITE, buildStatus: "live" })).toBe(true);
  });

  it("still shows when the registered URL is a Zavi-built app", () => {
    expect(
      show({
        productUrl: {
          status: "ok",
          value: { marketing: "https://upcarai-6ec4d609.onrender.com" },
        },
      }),
    ).toBe(true);
  });

  it("hides while the product read is pending, and when it FAILED", () => {
    expect(show({ productUrl: { status: "loading" } })).toBe(false);
    expect(show({ productUrl: { status: "error" } })).toBe(false);
  });

  it("keeps Stop and refine when the product read fails mid-build", () => {
    expect(show({ productUrl: { status: "error" }, buildStatus: "building" })).toBe(true);
    expect(show({ productUrl: { status: "loading" }, buildStatus: "live" })).toBe(true);
  });
});

describe("ownSiteBlocksBuild", () => {
  it("blocks a tenant who already runs their own site", () => {
    expect(
      ownSiteBlocksBuild({ status: "ok", value: { marketing: "https://www.upcar.ai" } }),
    ).toBe(true);
  });

  it("allows a tenant with no product of their own", () => {
    expect(ownSiteBlocksBuild({ status: "ok", value: {} })).toBe(false);
  });

  it("allows a tenant whose registered URL is a Zavi-built app", () => {
    expect(
      ownSiteBlocksBuild({
        status: "ok",
        value: { marketing: "https://upcarai-6ec4d609.onrender.com" },
      }),
    ).toBe(false);
  });

  it("blocks while the read is pending, and when it FAILED", () => {
    expect(ownSiteBlocksBuild({ status: "loading" })).toBe(true);
    expect(ownSiteBlocksBuild({ status: "error" })).toBe(true);
  });
});
