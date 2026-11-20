import { beforeEach, describe, expect, it, vi } from "vitest";

const assertSafeUrl = vi.fn(async (_url: string) => undefined);
vi.mock("@/services/onboarding/enrichment/url-guard", () => ({
  assertSafeUrl: (url: string) => assertSafeUrl(url),
  SsrfBlockedError: class extends Error {},
}));

import { admitSite } from "../admission";

beforeEach(() => {
  assertSafeUrl.mockClear();
});

describe("admitSite", () => {
  it("refuses a social profile or store listing without fetching it", async () => {
    for (const raw of [
      "facebook.com",
      "https://www.facebook.com/greenfarm",
      "instagram.com/greenfarm",
      "linktr.ee/greenfarm",
      "https://www.amazon.co.uk/stores/greenfarm",
    ]) {
      expect(await admitSite(raw), raw).toEqual({ ok: false, code: "invalid_url" });
    }
    expect(assertSafeUrl).not.toHaveBeenCalled();
  });

  it("admits the founder's own site", async () => {
    expect(await admitSite("www.greenfarm.com/about")).toEqual({
      ok: true,
      site: { url: "https://greenfarm.com/", domain: "greenfarm.com" },
    });
  });
});
