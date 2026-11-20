import { beforeEach, describe, expect, it } from "vitest";
import { SITE_PREVIEW_CONFIG_CHECK_MS, __resetSitePreviewConfigChecks, claimSitePreviewConfigCheck } from "../autopilot";

beforeEach(() => __resetSitePreviewConfigChecks());

describe("checking a live site preview's runtime config from build-status", () => {
  it("claims one check per site per window, however often the page polls", () => {
    const t0 = 1_000_000;
    expect(claimSitePreviewConfigCheck("site-a", t0)).toBe(true);
    for (let i = 1; i < 60; i++) expect(claimSitePreviewConfigCheck("site-a", t0 + i * 2_000)).toBe(false);
    expect(claimSitePreviewConfigCheck("site-b", t0 + 1)).toBe(true);
    expect(claimSitePreviewConfigCheck("site-a", t0 + SITE_PREVIEW_CONFIG_CHECK_MS)).toBe(true);
  });
});
