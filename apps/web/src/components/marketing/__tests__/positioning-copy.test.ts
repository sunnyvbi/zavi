import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const read = (p: string) => readFileSync(join(__dirname, p), "utf8");
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const shippedText = (s: string) => stripComments(s).replace(/\s+/g, " ");

const MARKETING_DIR = join(__dirname, "..");
const APP_DIR = join(__dirname, "../../../app");

const componentSurfaces = (): Record<string, string> =>
  Object.fromEntries(
    readdirSync(MARKETING_DIR)
      .filter((f) => f.endsWith(".tsx"))
      .map((f) => [f, readFileSync(join(MARKETING_DIR, f), "utf8")]),
  );

const growthHomeSurfaces = (): Record<string, string> =>
  Object.fromEntries(
    ["growth-home", "growth-home/channels", "growth-home/pricing"].flatMap((sub) => {
      const dir = join(MARKETING_DIR, sub);
      return readdirSync(dir)
        .filter((f) => f.endsWith(".tsx") && !f.includes(".test."))
        .map((f) => [`${sub}/${f}`, readFileSync(join(dir, f), "utf8")] as const);
    }),
  );

const optionalAppSurface = (path: string): Record<string, string> => {
  const absolute = join(APP_DIR, path);
  return existsSync(absolute) ? { [path]: readFileSync(absolute, "utf8") } : {};
};

const SURFACES: Record<string, string> = {
  ...componentSurfaces(),
  "layout.tsx": readFileSync(join(APP_DIR, "layout.tsx"), "utf8"),
  "opengraph-image.tsx": readFileSync(join(APP_DIR, "opengraph-image.tsx"), "utf8"),
  "page.tsx": readFileSync(join(APP_DIR, "page.tsx"), "utf8"),
  "careers/page.tsx": readFileSync(join(APP_DIR, "careers/page.tsx"), "utf8"),
  ...optionalAppSurface("upcar/page.tsx"),
  "AuthMarketingPanel.tsx": read("../../auth/AuthMarketingPanel.tsx"),
  "llms.txt": readFileSync(join(APP_DIR, "../../public/llms.txt"), "utf8"),
};

it("the sweep actually picked up the marketing components (guard against an empty glob)", () => {
  expect(Object.keys(SURFACES).length).toBeGreaterThan(15);
  expect(SURFACES).toHaveProperty("PricingPlans.tsx");
  expect(SURFACES).toHaveProperty("AuthMarketingPanel.tsx");
  expect(Object.keys(growthHomeSurfaces())).toContain("growth-home/GrowthFooter.tsx");
});

describe("BUG 12 — the retired marketplace lead line is gone from every surface", () => {
  for (const [name, src] of Object.entries(SURFACES)) {
    it(`${name} does not ship it`, () => {
      expect(shippedText(src)).not.toMatch(/AI super agent for marketplaces/i);
    });
  }

  it("layout.tsx carries the product title instead", () => {
    expect(SURFACES["layout.tsx"]).toMatch(/Zavi: AI Growth Agent For Your Business/);
  });
});

describe("the retired taglines are gone from every public surface", () => {
  const walk = (dir: string, rel = ""): Array<[string, string]> =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e): Array<[string, string]> => {
      const p = join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) return e.name === "__tests__" ? [] : walk(p, r);
      return /\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name) ? [[r, readFileSync(p, "utf8")]] : [];
    });
  const PUBLIC: Record<string, string> = {
    ...SURFACES,
    ...Object.fromEntries(walk(MARKETING_DIR, "components/marketing")),
    ...Object.fromEntries(
      ["about", "blog", "careers", "compare", "use-cases", "docs/ai-clients", "channels", "pricing"].flatMap((r) =>
        existsSync(join(APP_DIR, r)) ? walk(join(APP_DIR, r), `app/${r}`) : [],
      ),
    ),
    "lib/marketing/comparisons.ts": readFileSync(join(APP_DIR, "../lib/marketing/comparisons.ts"), "utf8"),
  };
  it("the sweep reaches the .ts copy and nested routes", () => {
    expect(PUBLIC).toHaveProperty("components/marketing/homeFaq.ts");
    expect(PUBLIC).toHaveProperty("app/about/page.tsx");
    expect(PUBLIC).toHaveProperty("app/docs/ai-clients/page.tsx");
  });
  for (const [name, src] of Object.entries(PUBLIC)) {
    it(`${name} does not ship them`, () => {
      const shipped = shippedText(src);
      expect(shipped, `${name} says Lovable for growth`).not.toMatch(/Lovable for growth/i);
      expect(shipped, `${name} calls Zavi a growth officer`).not.toMatch(/growth officer/i);
      expect(shipped, `${name} says AI cofounder team`).not.toMatch(/cofounder team/i);
      expect(shipped, `${name} says super agent`).not.toMatch(/\bsuper agent\b/);
    });
  }
});

describe("BUG 19 — no surface claims L4 autonomy", () => {
  it("the growth home title no longer says it owns the number", () => {
    expect(shippedText(SURFACES["page.tsx"])).not.toMatch(/owns your number/i);
  });

  it("no marketing surface claims to own a metric, or to run unattended overnight", () => {
    for (const [name, src] of Object.entries(SURFACES)) {
      const shipped = shippedText(src);
      expect(shipped, `${name} claims to own a metric`).not.toMatch(
        /owns? your (number|metric|growth)\b/i,
      );
      expect(shipped, `${name} claims unattended autonomy`).not.toMatch(/while you sleep/i);
    }
  });

  it("no surface headlines a marketplace at the SMB cohort", () => {
    for (const [name, src] of Object.entries(SURFACES)) {
      expect(shippedText(src), `${name} still headlines a marketplace`).not.toMatch(
        /Run your marketplace with a super agent/i,
      );
    }
  });

  it("no surface says the growth runs on autopilot", () => {
    for (const [name, src] of Object.entries(SURFACES)) {
      expect(shippedText(src), `${name} says autopilot`).not.toMatch(/\bon autopilot\b/i);
    }
  });

  it("no surface claims 24/7 operation or fine-tuned models", () => {
    for (const [name, src] of Object.entries({ ...SURFACES, ...growthHomeSurfaces() })) {
      const text = shippedText(src);
      expect(text, `${name} says 24/7`).not.toMatch(/24\/7|around the clock/i);
      expect(text, `${name} says fine-tuned`).not.toMatch(/fine-tun/i);
      expect(text, `${name} claims attribution`).not.toMatch(/caused the change|proves? the lift/i);
    }
  });
});

describe("no placeholder or invented person ships on a public surface", () => {
  for (const [name, src] of Object.entries(SURFACES)) {
    it(`${name} ships no placeholder copy`, () => {
      const shipped = shippedText(src);
      expect(shipped, `${name} has placeholder copy`).not.toMatch(
        /placeholder (operator|testimonial|quote|customer)/i,
      );
      expect(shipped, `${name} has a TODO addressed to a human`).not.toMatch(
        /\(\s*Ravi to replace\.?\s*\)/i,
      );
      expect(shipped, `${name} ships lorem ipsum`).not.toMatch(/lorem ipsum/i);
    });
  }
});

describe("no surface pitches Zavi as a marketplace product", () => {
  const BANNED: RegExp[] = [
    /\byour marketplace\b/i,
    /\bfor marketplaces\b/i,
    /\bmarketplace operators?\b/i,
    /Build (a|my) marketplace/i,
    /Grow (your )?marketplace/i,
    /Do 10x more on your marketplace/i,
    /seller onboarding/i,
    /two-sided marketplace/i,
  ];
  const ALL = { ...SURFACES, ...growthHomeSurfaces() };
  it("the growth-home sweep picked up files", () => {
    expect(ALL).toHaveProperty("growth-home/GrowthHero.tsx");
  });
  for (const [name, src] of Object.entries(ALL)) {
    it(`${name} carries no marketplace positioning`, () => {
      const shipped = shippedText(src);
      for (const re of BANNED) {
        expect(shipped, `${name} matches ${re}`).not.toMatch(re);
      }
    });
  }

  it("the growth home renders no old-layout section", () => {
    const PAGE = SURFACES["page.tsx"];
    for (const gone of ["MarketplaceBuilder", "HowZaviWorks", "HeroLiveFeed", "BuildOrGrowCta"]) {
      expect(PAGE).not.toMatch(new RegExp(`<${gone}\\b`));
    }
  });
});

describe("use-case pages make no claim Zavi has not earned", () => {
  const LIB_DIR = join(__dirname, "../../../lib/marketing");
  const USE_CASE_SURFACES: Record<string, string> = {
    "lib/marketing/useCases.ts": readFileSync(join(LIB_DIR, "useCases.ts"), "utf8"),
    "growth-home/useCases/UseCasePageBody.tsx": readFileSync(
      join(MARKETING_DIR, "growth-home/useCases/UseCasePageBody.tsx"),
      "utf8",
    ),
    "use-cases/page.tsx": readFileSync(join(APP_DIR, "use-cases/page.tsx"), "utf8"),
    "use-cases/[slug]/page.tsx": readFileSync(join(APP_DIR, "use-cases/[slug]/page.tsx"), "utf8"),
    "growth-home/growthNavData.tsx": readFileSync(join(MARKETING_DIR, "growth-home/growthNavData.tsx"), "utf8"),
  };
  const BANNED: RegExp[] = [
    /autopilot/i,
    /fully autonomous/i,
    /guarantee/i,
    /testimonial/i,
    /runs your marketing for you/i,
    /owns? your (number|metric|growth)\b/i,
    /while you sleep/i,
    /\bL4\b/,
    /—/,
    /\byour marketplace\b/i,
    /\bfor marketplaces\b/i,
    /\bmarketplace operators?\b/i,
    /Grow (your )?marketplace/i,
    /two-sided marketplace/i,
    /seller onboarding/i,
  ];
  for (const [name, src] of Object.entries(USE_CASE_SURFACES)) {
    it(`${name} ships none of the banned claims`, () => {
      const shipped = shippedText(src);
      for (const re of BANNED) expect(shipped, `${name} matches ${re}`).not.toMatch(re);
    });
  }
});

describe("compare pages and the /about definition make no claim Zavi has not earned", () => {
  const LIB_DIR = join(__dirname, "../../../lib/marketing");
  const COMPARE_SURFACES: Record<string, string> = {
    "lib/marketing/comparisons.ts": readFileSync(join(LIB_DIR, "comparisons.ts"), "utf8"),
    "compare/ComparePageBody.tsx": readFileSync(join(MARKETING_DIR, "compare/ComparePageBody.tsx"), "utf8"),
    "aboutFaq.ts": readFileSync(join(MARKETING_DIR, "aboutFaq.ts"), "utf8"),
    "compare/[slug]/page.tsx": readFileSync(join(APP_DIR, "compare/[slug]/page.tsx"), "utf8"),
    "about/page.tsx": readFileSync(join(APP_DIR, "about/page.tsx"), "utf8"),
  };
  const BANNED: RegExp[] = [
    /fully autonomous/i,
    /guarantee/i,
    /testimonial/i,
    /owns? your (number|metric|growth)\b/i,
    /while you sleep/i,
    /\bL4\b/,
    /\bthe first AI\b/i,
    /caused the change|proves? the lift/i,
    /—/,
  ];
  for (const [name, src] of Object.entries(COMPARE_SURFACES)) {
    it(`${name} ships none of the banned claims`, () => {
      const shipped = shippedText(src);
      for (const re of BANNED) expect(shipped, `${name} matches ${re}`).not.toMatch(re);
    });
  }
});
