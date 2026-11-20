import { describe, expect, it, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  resolveBrandKit: vi.fn(),
  scrapeBrandKit: vi.fn(),
}));

vi.mock("@/services/brand/resolve-brand-kit", () => ({
  resolveBrandKit: (...a: unknown[]) => h.resolveBrandKit(...a),
  scrapeBrandKit: (...a: unknown[]) => h.scrapeBrandKit(...a),
  marketingUrlOf: (u: unknown) => (typeof u === "string" && u.trim() ? u.trim() : null),
}));

import { resolveTenantBrandKit } from "./_launch-video-brand-kit";

const kit = (over: Record<string, unknown> = {}) => ({
  primary: "#d71505",
  accent: "#3b82f6",
  bg: "#ffffff",
  text: "#191919",
  source: "scrape",
  source_url: "https://example.com",
  evidence: [],
  ...over,
});

const sbWith = (blob: Record<string, unknown>) =>
  ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: { blob } }) }),
      }),
    }),
  }) as never;

beforeEach(() => {
  h.resolveBrandKit.mockReset();
  h.scrapeBrandKit.mockReset();
});

describe("resolveTenantBrandKit", () => {
  it("takes the colours from the TABLE when the blob has no entry", async () => {
    h.resolveBrandKit.mockResolvedValue(kit());
    const out = await resolveTenantBrandKit("t1", sbWith({}));
    expect(out?.colors?.primary).toBe("#d71505");
    expect(out?.colors?.accent).toBe("#3b82f6");
  });

  it("keeps the blob's logo and voice while taking the table's colours", async () => {
    h.resolveBrandKit.mockResolvedValue(kit());
    const blob = { tenant_brand_kits: { t1: { logoUrl: "https://x/logo.png", voiceId: "v9" } } };
    const out = await resolveTenantBrandKit("t1", sbWith(blob));
    expect(out?.logoUrl).toBe("https://x/logo.png");
    expect(out?.voiceId).toBe("v9");
    expect(out?.colors?.primary).toBe("#d71505");
  });

  it("a colour set BY HAND in the blob outranks a scrape", async () => {
    h.resolveBrandKit.mockResolvedValue(kit());
    const blob = { tenant_brand_kits: { t1: { colors: { primary: "#111111" } } } };
    const out = await resolveTenantBrandKit("t1", sbWith(blob));
    expect(out?.colors?.primary).toBe("#111111");
    expect(h.resolveBrandKit).not.toHaveBeenCalled();
  });

  it("returns no colours for a kit we could not read — never our blue as theirs", async () => {
    h.resolveBrandKit.mockResolvedValue(kit({ source: "default", primary: "#027bff" }));
    const out = await resolveTenantBrandKit("t1", sbWith({}));
    expect(out?.colors).toBeUndefined();
  });

  it("NEVER fetches a URL — an anonymous visitor does not choose our egress", async () => {
    h.resolveBrandKit.mockResolvedValue(kit({ source: "default", primary: "#027bff" }));
    const out = await resolveTenantBrandKit("shell", sbWith({}));
    expect(out?.colors).toBeUndefined();
    expect(h.scrapeBrandKit).not.toHaveBeenCalled();
  });

  it("falls a missing accent back to the primary, never to the platform cyan", async () => {
    h.resolveBrandKit.mockResolvedValue(kit({ primary: "#d71505", accent: null }));
    const out = await resolveTenantBrandKit("t1", sbWith({}));
    expect(out?.colors?.accent).toBe("#d71505");
  });

  it("a brand read that throws never blocks the render", async () => {
    h.resolveBrandKit.mockRejectedValue(new Error("site down"));
    const out = await resolveTenantBrandKit("t1", sbWith({}));
    expect(out).toBeUndefined();
  });

  it("an unreadable config still reaches the table", async () => {
    h.resolveBrandKit.mockResolvedValue(kit());
    const sb = { from: () => { throw new Error("config unreadable"); } } as never;
    const out = await resolveTenantBrandKit("t1", sb);
    expect(out?.colors?.primary).toBe("#d71505");
  });
});
