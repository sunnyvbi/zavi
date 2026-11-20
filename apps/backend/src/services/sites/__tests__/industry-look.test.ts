import { describe, expect, it } from "vitest";
import { getThemePreset } from "@/services/provisioning/templates/vite-react-zavi/theme-presets";
import { contrast, parseDesignBrief, type DesignBrief } from "../design-brief";
import { designDirections, fallbackDesignBrief, presetBriefColors, withCompleteLook } from "../design-directions";
import { INDUSTRY_LOOK_RULES, applyIndustryLook } from "../industry-look";

const GYM_IDEA = "help me make gym website";

const SAAS_LOOK = {
  background: "#ffffff",
  foreground: "#0f172a",
  muted: "#f1f5f9",
  "muted-foreground": "#64748b",
  primary: "#2563eb",
  "primary-foreground": "#ffffff",
  border: "#e2e8f0",
};

function modelReply(over: Record<string, unknown>): string {
  const json = {
    industry: "Fitness",
    mood: "clean modern professional",
    mode: "light",
    colors: SAAS_LOOK,
    fonts: { heading: "Plus Jakarta Sans", body: "Inter" },
    audience: "People who want to get stronger",
    look: { base: "clean", layout: "split", alternates: ["fresh", "trust"] },
    visual_intent: { given: false, quote: "" },
    plan: {
      tone: "friendly",
      primary_action: { label: "Book a free class", steps: "Pick a class and book it." },
      pages: [{ path: "/", title: "Home", sections: [{ name: "Hero", headline: "Train with us", component: "Hero", variant: "split", image: { role: "hero", subject: "people lifting weights" } }] }],
    },
    ...over,
  };
  return `<brief_json>${JSON.stringify(json)}</brief_json>`;
}

function parsed(idea: string, over: Record<string, unknown> = {}): DesignBrief {
  const b = parseDesignBrief(modelReply(over), { idea });
  if (!b) throw new Error("brief did not parse");
  return b;
}

function hue(hex: string): { h: number; s: number } {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  if (d === 0) return { h: 0, s: 0 };
  const h = 60 * (max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4);
  return { h, s: d / (1 - Math.abs(2 * l - 1)) };
}

function readable(c: DesignBrief["colors"]): void {
  expect(contrast(c.foreground, c.background)).toBeGreaterThanOrEqual(4.5);
  expect(contrast(c["primary-foreground"], c.primary)).toBeGreaterThanOrEqual(4.5);
  expect(contrast(c["muted-foreground"], c.background)).toBeGreaterThanOrEqual(4.5);
  expect(contrast(c.foreground, c.muted)).toBeGreaterThanOrEqual(4.5);
}

const FITNESS = INDUSTRY_LOOK_RULES.find((r) => r.kind === "fitness")!;

describe("industry look rules: fitness", () => {
  it("the failing gym brief (white, corporate blue, Plus Jakarta Sans / Inter, split) gets a dark energetic recommended look, a strong heading and the bold layout", () => {
    const model = parsed(GYM_IDEA);
    expect(model.colors.primary).toBe("#2563eb");
    const brief = withCompleteLook(applyIndustryLook(model, GYM_IDEA), GYM_IDEA);
    const [rec, ...alts] = designDirections(brief);
    expect(rec!.recommended).toBe(true);
    expect(contrast(rec!.preset.colors.background, "#000000")).toBeLessThan(contrast(rec!.preset.colors.background, "#ffffff"));
    const { h, s } = hue(rec!.preset.colors.primary);
    expect(h <= 100 || h >= 345).toBe(true);
    expect(s).toBeGreaterThanOrEqual(0.6);
    expect(FITNESS.headings).toContain(rec!.preset.fonts.display);
    expect(rec!.layout).toBe("bold");
    expect(rec!.label.toLowerCase()).not.toContain("professional");
    expect(brief.mode).toBe("dark");
    expect(brief.look!.base).toBe("midnight");
    expect(alts.map((a) => a.id)).not.toContain("midnight");
    expect(brief.colors).toEqual(presetBriefColors(getThemePreset("midnight")!));
    readable(brief.colors);
  });

  it("gymnastics, calisthenics and cheer clubs are held to the fitness rule too", () => {
    const midnight = presetBriefColors(getThemePreset("midnight")!);
    for (const idea of ["FlexForm Gymnastics: classes for kids and teens", "A calisthenics park crew", "Cheerleading academy in Dallas"]) {
      const out = applyIndustryLook(parsed(idea, { industry: "Sports" }), idea);
      expect(out.colors).toEqual(midnight);
      expect(out.look?.layout).toBe("bold");
    }
  });

  it("a gym brief that already fits the rule is returned unchanged, byte for byte", () => {
    const dark = parsed(GYM_IDEA, {
      mode: "dark",
      colors: { background: "#0d0d0d", foreground: "#fafafa", muted: "#1c1c1c", "muted-foreground": "#a3a3a3", primary: "#f97316", "primary-foreground": "#111111", border: "#2a2a2a" },
      fonts: { heading: "Bricolage Grotesque", body: "DM Sans" },
      look: { base: "midnight", layout: "bold", alternates: ["sunny"] },
    });
    const before = JSON.stringify(dark);
    expect(applyIndustryLook(dark, GYM_IDEA)).toBe(dark);
    expect(JSON.stringify(dark)).toBe(before);

    const light = parsed("A boxing club in Leeds with evening classes", {
      colors: { background: "#ffffff", foreground: "#0a0a0a", muted: "#f4f4f5", "muted-foreground": "#52525b", primary: "#dc2626", "primary-foreground": "#ffffff", border: "#e4e4e7" },
      fonts: { heading: "Archivo", body: "Inter" },
      look: { base: "studio", layout: "bold", alternates: [] },
    });
    expect(applyIndustryLook(light, "A boxing club in Leeds with evening classes")).toBe(light);
  });

  it("keeps the parts that fit and replaces only the ones that break the rule", () => {
    const colors = { background: "#0d0d0d", foreground: "#fafafa", muted: "#1c1c1c", "muted-foreground": "#a3a3a3", primary: "#facc15", "primary-foreground": "#111111", border: "#2a2a2a" };
    const b = parsed("CrossFit box with 6am bootcamp sessions", { mode: "dark", colors, look: { base: "sunny", layout: "split", alternates: [] } });
    const out = applyIndustryLook(b, "CrossFit box with 6am bootcamp sessions");
    expect(out.colors).toEqual(colors);
    expect(out.mood).toBe(b.mood);
    expect(out.look!.base).toBe("sunny");
    expect(out.look!.layout).toBe("bold");
    expect(FITNESS.headings).toContain(out.fonts.heading);
  });

  it("the deterministic fallback for a gym is held to the same rule", () => {
    const brief = applyIndustryLook(fallbackDesignBrief({ idea: GYM_IDEA }), GYM_IDEA);
    expect(brief.mode).toBe("dark");
    expect(brief.look!.layout).toBe("bold");
    expect(FITNESS.headings).toContain(brief.fonts.heading);
  });

  it("a gym whose idea sets the look itself is left alone", () => {
    const idea = "a gym in a law firm style, navy and serif";
    const b = parsed(idea, { visual_intent: { given: true, quote: "in a law firm style" } });
    expect(b.look_given).toBe("idea");
    expect(applyIndustryLook(b, idea)).toBe(b);
    for (const look_given of ["references", "template"] as const) {
      const given = { ...parsed(GYM_IDEA), look_given };
      expect(applyIndustryLook(given, GYM_IDEA)).toBe(given);
    }
  });

  it("a gym idea that names its own colours keeps them", () => {
    const idea = "gym website in blue and white";
    const out = applyIndustryLook(parsed(idea), idea);
    expect(out.colors).toEqual({ ...SAAS_LOOK, "muted-foreground": expect.any(String) });
    expect(contrast(out.colors["muted-foreground"], out.colors.muted)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("industry look rules: the generic look", () => {
  it("a software idea with the blue / Inter look takes the product look", () => {
    const idea = "A SaaS app that helps freelancers send invoices";
    const b = parsed(idea, { industry: "Software" });
    const out = applyIndustryLook(b, idea);
    expect(out.look!.base).toBe("precise");
    expect(out.colors.primary).not.toBe(SAAS_LOOK.primary);
    readable(out.colors);
  });

  it("a law firm keeps the model's calm blue: there it is the right call", () => {
    const idea = "A family law firm offering free first consultations";
    const b = parsed(idea, { industry: "Law" });
    expect(applyIndustryLook(b, idea)).toBe(b);
  });

  it("a bakery with the blue / Inter look takes its top preset's colours and fonts", () => {
    const idea = "A neighbourhood bakery taking pre-orders for sourdough loaves and celebration cakes";
    const b = parsed(idea, { industry: "Bakery" });
    const out = applyIndustryLook(b, idea);
    const editorial = getThemePreset("editorial")!;
    expect(out.colors).toEqual(presetBriefColors(editorial));
    expect(out.fonts).toEqual({ heading: editorial.fonts.display, body: editorial.fonts.body });
    expect(out.look!.base).toBe("editorial");
    expect(out.look!.layout).toBe(b.look!.layout);
    expect(out.mode).toBe("light");
    readable(out.colors);
  });

  it("an idea no preset is made for, left on blue / Inter, gets a look picked from the idea (never blue)", () => {
    const idea = "A knitting circle that meets on Thursdays";
    const b = parsed(idea, { industry: "Hobby group" });
    const out = applyIndustryLook(b, idea);
    expect(out.colors.primary).not.toBe(SAAS_LOOK.primary);
    expect(applyIndustryLook(b, idea)).toEqual(out);
    readable(out.colors);
  });

  it("an idea no preset is made for keeps a blue look with its own distinctive fonts", () => {
    const idea = "A knitting circle that meets on Thursdays";
    const b = parsed(idea, { industry: "Hobby group", fonts: { heading: "Fraunces", body: "Work Sans" } });
    expect(applyIndustryLook(b, idea)).toBe(b);
  });
});
