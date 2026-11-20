import { describe, expect, it } from "vitest";
import { contrast, parseDesignBrief, type DesignBrief } from "../design-brief";
import { fallbackDesignBrief, lookIsGiven, presetFitsIdea, rankPresetsForIdea } from "../design-directions";
import { applyIndustryLook, industryLookRule } from "../industry-look";

const GENERIC = {
  background: "#ffffff",
  foreground: "#0f172a",
  muted: "#f1f5f9",
  "muted-foreground": "#64748b",
  primary: "#2563eb",
  "primary-foreground": "#ffffff",
  border: "#e2e8f0",
};

function modelBrief(idea: string, industry: string): DesignBrief {
  const json = {
    industry,
    mood: "clean modern professional",
    mode: "light",
    colors: GENERIC,
    fonts: { heading: "Plus Jakarta Sans", body: "Inter" },
    audience: "Local customers",
    look: { base: "clean", layout: "split", alternates: ["fresh", "trust"] },
    visual_intent: { given: false, quote: "" },
  };
  const b = parseDesignBrief(`<brief_json>${JSON.stringify(json)}</brief_json>`, { idea });
  if (!b) throw new Error("brief did not parse");
  return b;
}

function darkBackground(bg: string): boolean {
  return contrast(bg, "#000000") < contrast(bg, "#ffffff");
}

describe("a studio that is not a recording studio is not pushed to Midnight", () => {
  const STUDIOS = [
    "A yoga studio in Leeds",
    "Pilates studio with reformer classes",
    "A dance studio for kids and adults",
    "Hair studio in Shoreditch",
    "Nail studio and lash bar",
    "Pottery studio offering wheel classes",
  ];

  for (const idea of STUDIOS) {
    it(`${idea}: neither the ranking, the fallback brief nor the generic-look swap lands on Midnight`, () => {
      expect(rankPresetsForIdea(idea)[0]).not.toBe("midnight");
      expect(presetFitsIdea("midnight", idea)).toBe(false);
      const fallback = fallbackDesignBrief({ idea });
      expect(fallback.look!.base).not.toBe("midnight");
      expect(fallback.mode).toBe("light");
      expect(darkBackground(fallback.colors.background)).toBe(false);
      const applied = applyIndustryLook(modelBrief(idea, "Studio"), idea);
      expect(applied.look?.base).not.toBe("midnight");
      expect(applied.mode).toBe("light");
      expect(darkBackground(applied.colors.background)).toBe(false);
    });
  }

  it("a recording studio still ranks, falls back and swaps to Midnight in either word order", () => {
    for (const idea of ["A recording studio for bands in Manchester", "A studio for recording podcasts and voiceovers"]) {
      expect(rankPresetsForIdea(idea)[0]).toBe("midnight");
      expect(presetFitsIdea("midnight", idea)).toBe(true);
      const fallback = fallbackDesignBrief({ idea });
      expect(fallback.look!.base).toBe("midnight");
      expect(fallback.mode).toBe("dark");
      const applied = applyIndustryLook(modelBrief(idea, "Music"), idea);
      expect(applied.look?.base).toBe("midnight");
      expect(darkBackground(applied.colors.background)).toBe(true);
    }
  });

  it("a nightclub keeps its single-word Midnight match; a tattoo parlour gets the dark refined look", () => {
    expect(rankPresetsForIdea("A nightclub in Soho with weekend DJs")[0]).toBe("midnight");
    expect(fallbackDesignBrief({ idea: "A nightclub in Soho with weekend DJs" }).look!.base).toBe("midnight");
    expect(presetFitsIdea("noir", "Tattoo parlour in Camden")).toBe(true);
  });
});

describe("a loose style word in a name or description is not a look the founder asked for", () => {
  const LOOSE: ReadonlyArray<readonly [string, string]> = [
    ["Dark Horse Coffee, a cafe in Bristol", "midnight"],
    ["Neon Sign Repairs, fixing shop signs across Leeds", "midnight"],
    ["Premium Car Wash and valeting in Leeds", "luxe"],
    ["Elegant Nails, a nail salon in Bath", "luxe"],
    ["Minimal Waste refill shop for groceries", "studio"],
    ["Soft Serve Sundays, an ice cream van", "fresh"],
    ["Pastel de nata bakery in Lisbon", "fresh"],
    ["Coastal Plumbing and heating engineers", "coastal"],
    ["Cheerful Cleaners, domestic cleaning in Bath", "sunny"],
    ["Rustic Pizza Co, wood-fired takeaway", "earthy"],
    ["The Newspaper Shop, a corner newsagent", "editorial"],
    ["Centered Physio, a sports injury clinic", "fresh"],
    ["Serif & Sons, an independent bookshop", "editorial"],
  ];

  for (const [idea, forced] of LOOSE) {
    it(`${idea}: the look picker stays open and no ${forced} preset is forced`, () => {
      const brief = fallbackDesignBrief({ idea });
      expect(brief.look_given).toBeUndefined();
      expect(brief.direction_given).toBeUndefined();
      expect(lookIsGiven(brief)).toBe(false);
    });
  }

  it("Dark Horse Coffee gets a light cafe look, not Midnight", () => {
    const brief = fallbackDesignBrief({ idea: "Dark Horse Coffee, a cafe in Bristol" });
    expect(brief.look!.base).toBe("editorial");
    expect(brief.mode).toBe("light");
    expect(darkBackground(brief.colors.background)).toBe(false);
  });

  it("a model brief for Dark Horse Coffee is still eligible for the industry look, since the idea set no look", () => {
    const idea = "Dark Horse Coffee, a cafe in Bristol";
    const applied = applyIndustryLook(modelBrief(idea, "Cafe"), idea);
    expect(applied.look?.base).toBe("editorial");
    expect(darkBackground(applied.colors.background)).toBe(false);
  });
});

describe("an explicit style request still sets the look", () => {
  const ASKED: ReadonlyArray<readonly [string, string, boolean]> = [
    ["dark mode please, a cafe in Bristol", "midnight", true],
    ["A cafe in Bristol with a dark theme", "midnight", true],
    ["Cocktail bar, I want a dark, moody website", "midnight", true],
    ["A bakery with a minimal design", "studio", false],
    ["Car wash in Leeds, make it look premium", "luxe", false],
    ["Florist in Bath, something elegant", "luxe", false],
    ["A bookshop with a magazine style layout", "editorial", false],
    ["Kids party planner, keep it playful and colourful", "sunny", false],
    ["Surf school, go for a beachy vibe", "coastal", false],
    ["Dentist with soft pastels throughout", "fresh", false],
  ];

  for (const [idea, preset, dark] of ASKED) {
    it(`${idea} -> ${preset}`, () => {
      const brief = fallbackDesignBrief({ idea });
      expect(brief.look_given).toBe("idea");
      expect(lookIsGiven(brief)).toBe(true);
      expect(brief.look!.base).toBe(preset);
      expect(brief.mode).toBe(dark ? "dark" : "light");
      expect(darkBackground(brief.colors.background)).toBe(dark);
    });
  }

  it("a serif or centred layout request sets the look without forcing a preset", () => {
    const serif = fallbackDesignBrief({ idea: "An independent bookshop, I want a serif font for headings" });
    expect(serif.look_given).toBe("idea");
    const centred = fallbackDesignBrief({ idea: "A dentist website with a centered layout" });
    expect(centred.look_given).toBe("idea");
    expect(centred.look!.layout).toBe("centered");
  });

  it("a minimal design request picks the minimal layout, a minimal-waste shop does not", () => {
    expect(fallbackDesignBrief({ idea: "A bakery with a minimal design" }).look!.layout).toBe("minimal");
    expect(fallbackDesignBrief({ idea: "Minimal Waste refill shop, I want a centered layout" }).look!.layout).toBe("centered");
  });

  it("dark black background with named colours still goes dark, while a Dark Horse brand with black and gold colours stays on its light background", () => {
    const boxing = fallbackDesignBrief({ idea: "A boxing gym website with a dark black background, red accents and bold typography" });
    expect(boxing.look_given).toBe("idea");
    expect(boxing.mode).toBe("dark");
    const horse = fallbackDesignBrief({ idea: "Dark Horse Coffee, a cafe in Bristol, black and gold colours" });
    expect(horse.look_given).toBe("idea");
    expect(horse.colors.background).not.toBe("#0a0a0a");
    expect(horse.mode).toBe("light");
  });

  it("an XML-escaped dark mode request still counts", () => {
    expect(fallbackDesignBrief({ idea: "Tom &amp; Jo&#39;s bar &mdash; dark mode please" }).look!.base).toBe("midnight");
  });
});

describe("fitness industry rule only fires for fitness businesses", () => {
  const NOT_FITNESS = [
    "A coding bootcamp for developers",
    "Data science boot camp for career changers",
    "Holiday cheer gift shop",
    "Boxer puppies breeder in Kent",
    "Boxing Day sale for our furniture shop",
    "Christmas cheer hampers and gifts",
  ];

  for (const idea of NOT_FITNESS) {
    it(`${idea}: no fitness rule, no Midnight bold look`, () => {
      expect(industryLookRule(idea)).toBeNull();
      const applied = applyIndustryLook(modelBrief(idea, "Retail"), idea);
      expect(applied.look?.layout).not.toBe("bold");
      expect(applied.look?.base).not.toBe("midnight");
      expect(darkBackground(applied.colors.background)).toBe(false);
    });
  }

  const FITNESS = [
    "A gym in Leeds",
    "CrossFit box with 6am classes",
    "Fitness bootcamp in the park",
    "Bootcamp workouts for busy mums",
    "Cheerleading academy in Dallas",
    "All-star cheer gym for teens",
    "Cheer squad training camp",
    "A boxing club in Leeds with evening classes",
    "Kickboxing and muay thai classes",
    "Personal trainer for new runners",
  ];

  for (const idea of FITNESS) {
    it(`${idea}: fitness rule fires and swaps a generic brief to Midnight bold`, () => {
      expect(industryLookRule(idea)?.kind).toBe("fitness");
      const applied = applyIndustryLook(modelBrief(idea, "Sports"), idea);
      expect(applied.look?.base).toBe("midnight");
      expect(applied.look?.layout).toBe("bold");
      expect(darkBackground(applied.colors.background)).toBe(true);
    });
  }
});
