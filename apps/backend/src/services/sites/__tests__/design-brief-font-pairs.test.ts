import { describe, expect, it } from "vitest";
import { BRIEF_FONT_PAIRS, generateDesignBrief, type DesignBrief } from "../design-brief";
import { applyDirectionToFiles, designDirections, withCompleteLook } from "../design-directions";
import { FONT_LIBRARY, THEME_CSS_PATH } from "@/services/provisioning/templates/vite-react-zavi/theme-presets";
import { TEMPLATE_FILES } from "@/services/provisioning/templates/vite-react-zavi/template-files.generated";

function modelReply(fonts: { heading: string; body: string }): string {
  return `<brief_json>${JSON.stringify({
    industry: "local business",
    mood: "warm and clear",
    mode: "light",
    colors: { background: "#ffffff", foreground: "#111827", muted: "#f3f4f6", "muted-foreground": "#4b5563", primary: "#1d4ed8", "primary-foreground": "#ffffff", border: "#e5e7eb" },
    fonts,
  })}</brief_json>`;
}

async function briefFor(idea: string, fonts: { heading: string; body: string }): Promise<DesignBrief> {
  const r = await generateDesignBrief({ idea }, { call: async () => modelReply(fonts) });
  if (!r.brief) throw new Error(`no brief: ${(r as { reason: string }).reason}`);
  return r.brief;
}

function themeCss(brief: DesignBrief, idea: string): string {
  const full = withCompleteLook(brief, idea);
  const brand = designDirections(full)[0]!;
  return applyDirectionToFiles(TEMPLATE_FILES, full, brand)[THEME_CSS_PATH]!;
}

describe("starter font pairs", () => {
  it("a plain Inter / DM Sans pick becomes a distinctive pair for the business, loaded and tokenised in the theme", async () => {
    const idea = "A neighbourhood bakery selling sourdough and pastries";
    const brief = await briefFor(idea, { heading: "Inter", body: "Inter" });
    expect(brief.fonts).toEqual({ heading: "Fraunces", body: "Figtree" });
    const css = themeCss(brief, idea);
    expect(css).toContain("family=Fraunces:wght@");
    expect(css).toContain("family=Figtree:wght@");
    expect(css).toMatch(/--font-display: "Fraunces", "Fraunces Fallback"/);
    expect(css).toMatch(/--font-body: "Figtree", "Figtree Fallback"/);
  });

  it("the pair follows the business: a dental clinic and a law firm get different pairs", async () => {
    expect((await briefFor("A family dentist clinic for nervous patients", { heading: "DM Sans", body: "Inter" })).fonts).toEqual({ heading: "Plus Jakarta Sans", body: "Lora" });
    expect((await briefFor("A small law and accounting practice", { heading: "Inter", body: "DM Sans" })).fonts).toEqual({ heading: "Playfair Display", body: "Source Sans 3" });
  });

  it("a distinctive pick, or a font the idea itself names, is kept", async () => {
    expect((await briefFor("A bakery", { heading: "Playfair Display", body: "Lato" })).fonts).toEqual({ heading: "Playfair Display", body: "Lato" });
    expect((await briefFor("A bakery site, set everything in Inter please", { heading: "Inter", body: "Inter" })).fonts).toEqual({ heading: "Inter", body: "Inter" });
  });

  it("every curated pair renders with metric-matched fallbacks, so no pair loads a font the starter cannot size", () => {
    for (const p of BRIEF_FONT_PAIRS) {
      expect(FONT_LIBRARY[p.heading], p.heading).toBeDefined();
      expect(FONT_LIBRARY[p.body], p.body).toBeDefined();
    }
    expect(new Set(BRIEF_FONT_PAIRS.map((p) => p.heading)).size).toBe(BRIEF_FONT_PAIRS.length);
  });
});
