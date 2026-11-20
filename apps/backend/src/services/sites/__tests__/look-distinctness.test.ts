import { describe, expect, it } from "vitest";
import { getThemePreset } from "@/services/provisioning/templates/vite-react-zavi/theme-presets";
import { briefTraits, designDirections, fallbackDesignBrief, presetTraits, traitDistance, withCompleteLook } from "../design-directions";
import { applyIndustryLook } from "../industry-look";

const IDEAS = [
  "Bike rental shop in Austin",
  "Tattoo studio in Brooklyn",
  "B2B SaaS for invoice automation",
  "A neighbourhood bakery with celebration cakes",
  "A family dentist",
  "A knitting circle that meets on Thursdays",
  "Yoga studio classes",
  "Law firm for small businesses",
];

function looks(idea: string) {
  const brief = withCompleteLook(applyIndustryLook(fallbackDesignBrief({ idea }), idea), idea);
  const dirs = designDirections(brief);
  return { brief, dirs, traits: [briefTraits(brief), ...dirs.slice(1).map((d) => presetTraits(d.preset))] };
}

describe("the three looks", () => {
  it.each(IDEAS)("are three, and each pair differs at a glance: %s", (idea) => {
    const { dirs, traits } = looks(idea);
    expect(dirs).toHaveLength(3);
    for (let i = 0; i < traits.length; i++) for (let j = i + 1; j < traits.length; j++) expect(traitDistance(traits[i]!, traits[j]!)).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < traits.length; i++) for (let j = i + 1; j < traits.length; j++) expect(traitDistance(traits[i]!, traits[j]!, { corners: false })).toBeGreaterThanOrEqual(1);
    expect(traitDistance(traits[0]!, traits[1]!) + traitDistance(traits[0]!, traits[2]!)).toBeGreaterThanOrEqual(4);
  });

  it("a dark specialist look is never offered to a business it was not made for", () => {
    for (const idea of ["A family dentist", "Law firm for small businesses", "A knitting circle that meets on Thursdays"]) {
      const ids = looks(idea).dirs.map((d) => d.id);
      expect(ids).not.toContain("midnight");
      expect(ids).not.toContain("noir");
    }
  });

  it("fits the business: a bike shop is active, a tattoo studio dark, software its product look", () => {
    expect(looks("Bike rental shop in Austin").brief.look?.base).toBe("active");
    expect(looks("Tattoo studio in Brooklyn").brief.look?.base).toBe("noir");
    expect(looks("B2B SaaS for invoice automation").brief.look?.base).toBe("precise");
  });

  it("presets on the same traits are told apart: two warm light serif looks are close, a dark one is far", () => {
    const sunny = presetTraits(getThemePreset("sunny")!);
    expect(traitDistance(sunny, presetTraits(getThemePreset("editorial")!))).toBeLessThanOrEqual(1);
    expect(traitDistance(sunny, presetTraits(getThemePreset("midnight")!))).toBeGreaterThanOrEqual(3);
  });
});

describe("a model brief whose own alternative only differs in corners", () => {
  it("drops it: a warm serif bakery look is never offered next to the same warm serif look", async () => {
    const { designDirections: dd, briefTraits: bt, presetTraits: pt, traitDistance: td } = await import("../design-directions");
    const brief = withCompleteLook(
      {
        industry: "Artisan cake bakery",
        mood: "warm joyful homemade",
        mode: "light",
        colors: { background: "#faf8f6", foreground: "#2b1d14", muted: "#f3ebe4", "muted-foreground": "#6b5444", primary: "#d4714f", "primary-foreground": "#ffffff", border: "#eaded4" },
        fonts: { heading: "Fraunces", body: "Figtree" },
        look: { base: "petal", layout: "centered", alternates: ["luxe", "editorial"] },
        source: "model",
      },
      "A home bakery making celebration cakes",
    );
    const dirs = dd(brief);
    expect(dirs.map((d) => d.id)).not.toContain("editorial");
    for (const d of dirs.slice(1)) expect(td(bt(brief), pt(d.preset), { corners: false })).toBeGreaterThanOrEqual(1);
  });
});
