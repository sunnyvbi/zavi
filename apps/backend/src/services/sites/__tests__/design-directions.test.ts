import { describe, expect, it } from "vitest";
import {
  THEME_CSS_PATH,
  THEME_PRESETS,
  getThemePreset,
  renderThemeCss,
} from "@/services/provisioning/templates/vite-react-zavi/theme-presets";
import { parseBriefExtras, parseDesignBrief, type DesignBrief } from "../design-brief";
import {
  BRAND_DIRECTION_ID,
  applyDirectionToFiles,
  brandPreset,
  designDirections,
  directionInThemeCss,
  fallbackDesignBrief,
  findDirection,
  isStoredBrief,
  parseStoredDirections,
  rankPresetsForIdea,
  themeModeOf,
  withCompleteLook,
} from "../design-directions";

const BRIEF: DesignBrief = {
  industry: "bakery",
  mood: "warm crafted honest",
  mode: "light",
  colors: {
    background: "#fffaf3",
    foreground: "#231a12",
    muted: "#f4ebe0",
    "muted-foreground": "#5e4a3a",
    primary: "#a8461f",
    "primary-foreground": "#ffffff",
    border: "#e7d8c6",
  },
  fonts: { heading: "Fraunces", body: "Inter" },
  look: { base: "editorial", layout: "editorial", alternates: ["sunny", "clean"] },
  source: "model",
};

const SHAPES = {
  bakery: "A neighbourhood bakery taking pre-orders for sourdough loaves and celebration cakes, pick up Saturday mornings.",
  dentist: "A family dentist in a small town; patients book check-ups and cleanings online and see opening hours.",
  photographer: "Portfolio site for a wedding and portrait photographer with galleries and an enquiry form.",
};

describe("design directions", () => {
  it("offers the brief's own look first, then its two alternates, each a renderable theme", () => {
    const dirs = designDirections(BRIEF);
    expect(dirs.map((d) => d.id)).toEqual([BRAND_DIRECTION_ID, "clean", "sunny"]);
    expect(dirs[0].recommended).toBe(true);
    expect(dirs.slice(1).every((d) => !d.recommended)).toBe(true);
    for (const d of dirs) {
      const css = renderThemeCss(d.preset);
      expect(directionInThemeCss(css)).toBe(d.id);
    }
  });

  it("the brand look keeps the brief's colours and fonts on its base preset's shape", () => {
    const p = brandPreset(BRIEF);
    const base = getThemePreset("editorial")!;
    expect(p.name).toBe(BRAND_DIRECTION_ID);
    expect(p.colors.primary).toBe("#a8461f");
    expect(p.fonts).toEqual({ display: "Fraunces", body: "Inter" });
    expect(p.radius).toBe(base.radius);
    expect(p.headingWeight).toBe(base.headingWeight);
    expect(renderThemeCss(p)).toContain("--primary: 168 70 31;");
  });

  it("a brief with a broken or short look is completed: a real base and two distinct alternates, never the base", () => {
    const partial = withCompleteLook({ ...BRIEF, look: { base: "nope", layout: "split", alternates: ["midnight", "midnight"] } }, SHAPES.bakery);
    expect(getThemePreset(partial.look!.base)).toBeTruthy();
    expect(partial.look!.alternates).toHaveLength(2);
    expect(new Set(partial.look!.alternates).size).toBe(2);
    expect(partial.look!.alternates).not.toContain(partial.look!.base);
    expect(partial.look!.alternates[0]).toBe("midnight");
    const none = withCompleteLook({ ...BRIEF, look: undefined }, SHAPES.photographer);
    expect(none.look!.alternates).toHaveLength(2);
    expect(designDirections(none)).toHaveLength(3);
  });

  it("the fallback brief fits each business shape from the idea alone and always renders", () => {
    const picks = Object.fromEntries(Object.entries(SHAPES).map(([k, idea]) => [k, fallbackDesignBrief({ idea })]));
    expect(picks.dentist.look!.base).toBe("fresh");
    expect(picks.photographer.look!.base).toBe("studio");
    for (const b of Object.values(picks)) {
      expect(b.source).toBe("fallback");
      expect(isStoredBrief(b)).toBe(true);
      expect(designDirections(withCompleteLook(b, ""))).toHaveLength(3);
      for (const d of designDirections(b)) expect(() => renderThemeCss(d.preset)).not.toThrow();
    }
    expect(rankPresetsForIdea(SHAPES.dentist)[0]).not.toBe("earthy");
  });

  it("an idea that matches nothing still gets a brief (the catalogue's default look)", () => {
    const b = fallbackDesignBrief({ idea: "xyzzy" });
    expect(THEME_PRESETS.some((p) => p.name === b.look!.base)).toBe(true);
    expect(b.plan).toBeUndefined();
  });

  it("a direction rewrites only theme.css on the theme starter, and only the token block + font link on the older one", () => {
    const sunny = findDirection(BRIEF, "sunny")!;
    const themed = { [THEME_CSS_PATH]: "/* old */", "src/index.css": "keep me", "index.html": "<html></html>" };
    expect(themeModeOf(themed)).toBe("theme_css");
    const out = applyDirectionToFiles(themed, BRIEF, sunny);
    expect(directionInThemeCss(out[THEME_CSS_PATH])).toBe("sunny");
    expect(out["src/index.css"]).toBe("keep me");

    const legacy = {
      "src/index.css": ":root {\n  --background: 255 255 255;\n  --primary: 37 99 235;\n}\nbody {\n  font-family: system-ui;\n}\n",
      "index.html": "<html><head>\n  </head><body></body></html>",
    };
    expect(themeModeOf(legacy)).toBe("index_css");
    const out2 = applyDirectionToFiles(legacy, BRIEF, sunny);
    expect(out2["src/index.css"]).not.toContain("--primary: 37 99 235;");
    expect(out2["index.html"]).toContain("fonts.googleapis.com");
    expect(themeModeOf({ "src/main.tsx": "" })).toBe("none");
  });

  it("stored looks are read back as they were offered, dropping any that no longer render", () => {
    const dirs = designDirections(BRIEF);
    const back = parseStoredDirections(JSON.parse(JSON.stringify([...dirs, { id: "x" }, { ...dirs[1], preset: { ...dirs[1].preset, name: "Bad Name" } }])));
    expect(back.map((d) => d.id)).toEqual(dirs.map((d) => d.id));
    expect(findDirection(BRIEF, "sunny", back)?.preset.colors.primary).toBe(dirs.find((d) => d.id === "sunny")!.preset.colors.primary);
    expect(findDirection(BRIEF, "midnight", back)).toBeNull();
  });
});

describe("the brief's extras", () => {
  it("keeps only facts the idea itself states", () => {
    const idea = "Dog grooming van serving Austin, open Tuesday to Saturday, full groom from $65.";
    const extras = parseBriefExtras({ facts: ["Serves Austin", "Open Tuesday to Saturday", "Full groom from $65", "Award-winning since 1998"] }, idea);
    expect(extras.facts).toEqual(["Serves Austin", "Open Tuesday to Saturday", "Full groom from $65"]);
  });

  it("drops a look that names no real preset, and keeps an empty photo plan (the founder wants no photos)", () => {
    const extras = parseBriefExtras({ look: { base: "neon", alternates: ["luxe"] }, imagery: { subjects: [], style: "type only" } });
    expect(extras.look).toBeUndefined();
    expect(extras.imagery).toEqual({ subjects: [], style: "type only" });
  });

  it("a model brief carries its extras and is marked as the model's", () => {
    const raw = {
      industry: "portrait photography",
      mood: "quiet bold modern",
      mode: "light",
      colors: { background: "#ffffff", foreground: "#111111", muted: "#f2f2f2", "muted-foreground": "#555555", primary: "#111111", "primary-foreground": "#ffffff", border: "#e5e5e5" },
      fonts: { heading: "Archivo", body: "Figtree" },
      audience: "Couples planning a wedding",
      look: { base: "studio", layout: "minimal", alternates: ["luxe", "editorial"] },
    };
    const b = parseDesignBrief(`<brief_json>${JSON.stringify(raw)}</brief_json>`, { idea: SHAPES.photographer })!;
    expect(b.source).toBe("model");
    expect(b.fonts).toEqual({ heading: "Archivo", body: "Figtree" });
    expect(b.look).toEqual({ base: "studio", layout: "minimal", alternates: ["luxe", "editorial"] });
    expect(b.audience).toBe("Couples planning a wedding");
  });
});
