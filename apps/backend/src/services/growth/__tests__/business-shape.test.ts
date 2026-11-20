import { describe, it, expect, vi } from "vitest";
import { fillBusinessShape, marketingUrl, resolveBusinessShape, type ShapeFillDeps, type ShapeReads } from "../business-shape";

const T = "00000000-0000-4000-8000-0000000000aa";

const reads = (over: Partial<ShapeReads> = {}): ShapeReads & { fill: ReturnType<typeof vi.fn> } => ({
  companyShape: async () => ({ shape: null, source: null }),
  marketplaceConfirmed: async () => false,
  fill: vi.fn(async () => {}),
  ...over,
}) as ShapeReads & { fill: ReturnType<typeof vi.fn> };

const deps = (over: Partial<ShapeFillDeps> = {}) => {
  const d = {
    claimClassify: vi.fn(async () => true),
    siteText: vi.fn(async () => "Book a dog walker near you. Walkers set their own hours."),
    classify: vi.fn(async () => ({ shape: "marketplace" as const, confidence: "high" as const })),
    save: vi.fn(async () => {}),
    ...over,
  };
  return d;
};

describe("resolveBusinessShape", () => {
  it("a declared shape wins and nothing is filled", async () => {
    const r = reads({ companyShape: async () => ({ shape: "saas", source: "founder" }) });
    expect(await resolveBusinessShape(T, r)).toBe("saas");
    expect(r.fill).not.toHaveBeenCalled();
    const o = reads({ companyShape: async () => ({ shape: "other", source: null }), marketplaceConfirmed: async () => true });
    expect(await resolveBusinessShape(T, o)).toBe("other");
    expect(o.fill).not.toHaveBeenCalled();
  });

  it("a confirmed mapping replaces an inferred guess, never a founder's value", async () => {
    const guessed = reads({ companyShape: async () => ({ shape: "ecommerce", source: "inferred" }), marketplaceConfirmed: async () => true });
    expect(await resolveBusinessShape(T, guessed)).toBe("marketplace");
    expect(guessed.fill).toHaveBeenCalledWith(T, true);
    const unconfirmed = reads({ companyShape: async () => ({ shape: "ecommerce", source: "inferred" }) });
    expect(await resolveBusinessShape(T, unconfirmed)).toBe("ecommerce");
    expect(unconfirmed.fill).not.toHaveBeenCalled();
    expect(await resolveBusinessShape(T, reads({ companyShape: async () => ({ shape: "marketplace", source: "inferred" }) }))).toBeNull();
    expect(await resolveBusinessShape(T, reads({ companyShape: async () => ({ shape: "marketplace", source: "inferred" }), marketplaceConfirmed: async () => true }))).toBe("marketplace");
    const founder = reads({ companyShape: async () => ({ shape: "ecommerce", source: "founder" }), marketplaceConfirmed: async () => true });
    expect(await resolveBusinessShape(T, founder)).toBe("ecommerce");
    expect(founder.fill).not.toHaveBeenCalled();
  });

  it("an empty field is filled in the background; a confirmed mapping still answers marketplace now", async () => {
    const r = reads({ marketplaceConfirmed: async () => true });
    expect(await resolveBusinessShape(T, r)).toBe("marketplace");
    expect(r.fill).toHaveBeenCalledWith(T, true);
    const u = reads();
    expect(await resolveBusinessShape(T, u)).toBeNull();
    expect(u.fill).toHaveBeenCalledWith(T, false);
  });

  it("a fill that fails never breaks the answer", async () => {
    const r = reads({ fill: vi.fn(async () => Promise.reject(new Error("db down"))) as never });
    expect(await resolveBusinessShape(T, r)).toBeNull();
  });
});

describe("fillBusinessShape", () => {
  it("a confirmed marketplace setup is saved without running the classifier", async () => {
    const d = deps();
    await fillBusinessShape(T, true, d);
    expect(d.save).toHaveBeenCalledWith(T, "marketplace", "mapping");
    expect(d.claimClassify).not.toHaveBeenCalled();
  });

  it("saves any type the classifier is sure of: a SaaS site becomes saas", async () => {
    const d = deps({ classify: vi.fn(async () => ({ shape: "saas" as const, confidence: "high" as const })) });
    await fillBusinessShape(T, false, d);
    expect(d.save).toHaveBeenCalledWith(T, "saas", "inferred");
  });

  it("a confident marketplace guess is saved as inferred (it counts only once a mapping is confirmed)", async () => {
    const d = deps();
    await fillBusinessShape(T, false, d);
    expect(d.save).toHaveBeenCalledWith(T, "marketplace", "inferred");
  });

  it("low confidence, other, no site or a lost claim leave the field empty", async () => {
    for (const d of [
      deps({ classify: vi.fn(async () => ({ shape: "ecommerce" as const, confidence: "low" as const })) }),
      deps({ classify: vi.fn(async () => ({ shape: "other" as const, confidence: "high" as const })) }),
      deps({ siteText: vi.fn(async () => null) }),
      deps({ claimClassify: vi.fn(async () => false) }),
    ]) {
      await fillBusinessShape(T, false, d);
      expect(d.save).not.toHaveBeenCalled();
    }
  });

  it("the classifier runs at most once: a second caller that loses the claim never crawls", async () => {
    let claimed = false;
    const claimClassify = vi.fn(async () => (claimed ? false : ((claimed = true), true)));
    const siteText = vi.fn(async () => "Book a dog walker near you.");
    await Promise.all([fillBusinessShape(T, false, deps({ claimClassify, siteText })), fillBusinessShape(T, false, deps({ claimClassify, siteText }))]);
    expect(siteText).toHaveBeenCalledTimes(1);
  });

  it("a NULL or other result is still one attempt: later calls never run the classifier again", async () => {
    let claimed = false;
    const claimClassify = vi.fn(async () => (claimed ? false : ((claimed = true), true)));
    for (const result of [
      { shape: "services" as const, confidence: "low" as const },
      { shape: "other" as const, confidence: "high" as const },
    ]) {
      claimed = false;
      const classify = vi.fn(async () => result);
      const d = deps({ claimClassify, classify });
      await fillBusinessShape(T, false, d);
      await fillBusinessShape(T, false, d);
      await fillBusinessShape(T, false, d);
      expect(classify).toHaveBeenCalledTimes(1);
      expect(d.save).not.toHaveBeenCalled();
    }
    claimed = false;
    const noSite = deps({ claimClassify, siteText: vi.fn(async () => null) });
    await fillBusinessShape(T, false, noSite);
    await fillBusinessShape(T, false, noSite);
    expect(noSite.siteText).toHaveBeenCalledTimes(1);
  });

  it("never throws", async () => {
    await expect(fillBusinessShape(T, false, deps({ siteText: vi.fn(async () => Promise.reject(new Error("crawl blocked"))) }))).resolves.toBeUndefined();
  });
});

describe("marketingUrl", () => {
  it("reads the site from the stored {marketing, api} object, or an older plain string", () => {
    expect(marketingUrl({ marketing: "https://pottery.example", api: "https://api.pottery.example" })).toBe("https://pottery.example");
    expect(marketingUrl("pottery.example")).toBe("pottery.example");
    expect(marketingUrl({ api: "https://api.pottery.example" })).toBeNull();
    expect(marketingUrl(null)).toBeNull();
  });
});
