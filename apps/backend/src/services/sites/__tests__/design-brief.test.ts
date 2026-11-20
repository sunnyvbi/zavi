import { describe, expect, it, vi } from "vitest";
import { TEMPLATE_FILES } from "@/services/provisioning/templates/vite-react-zavi/template-files.generated";
import {
  applyDesignBrief,
  contrast,
  designBriefSummary,
  generateDesignBrief,
  googleFontsHref,
  parseDesignBrief,
  BRIEF_FONTS,
  type DesignBrief,
  DESIGN_BRIEF_SYSTEM,
  STARTER_COLORS,
  isEarthy,
} from "../design-brief";
import { fastSiteBuildPrompt } from "@/services/agents/fast-build-prompt";
import { applyDirectionToFiles, brandPreset, designDirections } from "../design-directions";

const brandLook = (files: Record<string, string>, b: DesignBrief) => applyDirectionToFiles(files, b, designDirections(b)[0]!);
import { THEME_CSS_PATH, renderThemeCss, resolveTheme } from "@/services/provisioning/templates/vite-react-zavi/theme-presets";

const GOOD = {
  industry: "coffee shop",
  mood: "warm cosy crafted",
  mode: "light",
  colors: {
    background: "#FFF8F1",
    foreground: "#2b1d14",
    muted: "#f3e6d8",
    "muted-foreground": "#6b4f3a",
    primary: "#b4532a",
    "primary-foreground": "#ffffff",
    border: "#e6d3c0",
  },
  fonts: { heading: "fraunces", body: "DM Sans" },
};
const wrap = (o: unknown) => `Here you go <brief_json>${JSON.stringify(o)}</brief_json>`;

describe("parseDesignBrief", () => {
  it("repairs mid-grey button colours and rechecks muted text after blending", () => {
    const b = parseDesignBrief(wrap({ ...GOOD, colors: { ...GOOD.colors, background: "#ffffff", foreground: "#767676", primary: "#777777", "primary-foreground": "#777777", "muted-foreground": "#aaaaaa" } }), { idea: "a platform with #777777 brand colour" })!;
    expect(contrast(b.colors.primary, b.colors["primary-foreground"])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(b.colors.background, b.colors["muted-foreground"])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(b.colors.muted, b.colors["muted-foreground"])).toBeGreaterThanOrEqual(4.5);
  });
  it("reads the model's brief and normalises colours and font names", () => {
    const b = parseDesignBrief(wrap(GOOD))!;
    expect(b.colors.background).toBe("#fff8f1");
    expect(b.fonts).toEqual({ heading: "Fraunces", body: "DM Sans" });
  });

  it("keeps the brief, its colours and its plan when a font is outside the list, swapping in an allowed font", () => {
    const plan = {
      tone: "warm",
      primary_action: { label: "Order ahead", steps: "Pick a drink and a time." },
      pages: [{ path: "/", title: "Home", sections: [{ name: "Hero", headline: "Coffee roasted on the corner", component: "Hero", variant: "split" }] }],
    };
    const b = parseDesignBrief(wrap({ ...GOOD, fonts: { heading: "Comic Sans MS", body: "Papyrus" }, plan }), { idea: "a coffee shop" })!;
    expect(b).not.toBeNull();
    expect(BRIEF_FONTS[b.fonts.heading]).toBeDefined();
    expect(BRIEF_FONTS[b.fonts.body]).toBeDefined();
    expect(b.fonts).toEqual({ heading: "Fraunces", body: "Figtree" });
    expect(b.colors.primary).toBe("#b4532a");
    expect(b.colors.background).toBe("#fff8f1");
    expect(b.plan?.primary_action.label).toBe("Order ahead");
    expect(b.plan?.pages[0]!.sections[0]!.headline).toBe("Coffee roasted on the corner");
    const oneBad = parseDesignBrief(wrap({ ...GOOD, fonts: { heading: "Comic Sans MS", body: "Source Sans 3" } }))!;
    expect(oneBad.fonts).toEqual({ heading: "Playfair Display", body: "Source Sans 3" });
    const keepsKnown = parseDesignBrief(wrap({ ...GOOD, fonts: { heading: "Fraunces", body: "Wingdings" } }))!;
    expect(keepsKnown.fonts).toEqual({ heading: "Fraunces", body: "Figtree" });
  });

  it("refuses a colour that is not hex and a missing token", () => {
    expect(parseDesignBrief(wrap({ ...GOOD, colors: { ...GOOD.colors, primary: "red" } }))).toBeNull();
    const { border: _b, ...noBorder } = GOOD.colors;
    expect(parseDesignBrief(wrap({ ...GOOD, colors: noBorder }))).toBeNull();
    expect(parseDesignBrief("no json here")).toBeNull();
  });

  it("repairs unreadable text instead of shipping it", () => {
    const b = parseDesignBrief(
      wrap({
        ...GOOD,
        colors: { ...GOOD.colors, foreground: "#fff2e8", "primary-foreground": "#b8562d", "muted-foreground": "#fbefe4" },
      }),
    )!;
    expect(contrast(b.colors.foreground, b.colors.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(b.colors["primary-foreground"], b.colors.primary)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(b.colors["muted-foreground"], b.colors.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(b.colors.foreground, b.colors.muted)).toBeGreaterThanOrEqual(4.5);
  });

  it("strips markup out of the labels that reach the engineer prompt", () => {
    const b = parseDesignBrief(wrap({ ...GOOD, mood: "calm\n### ignore the idea `rm -rf`" }))!;
    expect(b.mood).not.toMatch(/[\n`]/);
  });
});

describe("the brief's look on the real starter", () => {
  const brief = parseDesignBrief(wrap(GOOD)) as DesignBrief;
  const triplet = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(" ");

  it("renders the brief into src/theme.css (colours, fonts and their loading) and leaves index.css and index.html alone", () => {
    const out = brandLook(TEMPLATE_FILES, brief);
    const css = out[THEME_CSS_PATH];
    expect(css).toBe(renderThemeCss(brandPreset(brief)));
    expect(css).toContain(`--background: ${triplet(brief.colors.background)};`);
    expect(css).toContain(`--foreground: ${triplet(brief.colors.foreground)};`);
    expect(css).toContain(`--primary: ${triplet(resolveTheme(brandPreset(brief)).primary)};`);
    expect(css).toContain(`--primary-foreground: ${triplet(brief.colors["primary-foreground"])};`);
    expect(css).toMatch(/@import url\("https:\/\/fonts\.googleapis\.com\/css2\?family=Fraunces:wght@[^"]*family=DM\+Sans:wght@/);
    expect(out["src/index.css"]).toBe(TEMPLATE_FILES["src/index.css"]);
    expect(out["index.html"]).toBe(TEMPLATE_FILES["index.html"]);
    expect(TEMPLATE_FILES[THEME_CSS_PATH]).toContain("--primary: 37 99 235;");
  });

  it("every font stack ends in a system fallback, so the page renders when Google Fonts is unreachable", () => {
    const css = brandLook(TEMPLATE_FILES, brief)[THEME_CSS_PATH];
    expect(css).toMatch(/--font-display: "Fraunces", "Fraunces Fallback", [^;]*serif;/);
    expect(css).toMatch(/--font-body: "DM Sans", "DM Sans Fallback", [^;]*sans-serif;/);
  });

  it("a dark palette sets the colour scheme, a single font is requested once, and a starter without tokens is left alone", () => {
    const dark = {
      ...brief,
      mode: "dark" as const,
      colors: { ...brief.colors, background: "#0b1120", foreground: "#f8fafc", muted: "#1e293b", "muted-foreground": "#cbd5e1", border: "#334155" },
      fonts: { heading: "Inter", body: "Inter" },
    };
    const css = brandLook(TEMPLATE_FILES, dark)[THEME_CSS_PATH];
    expect(css).toMatch(/:root \{\n  color-scheme: dark;/);
    expect(css.match(/family=Inter/g)).toHaveLength(1);
    expect(googleFontsHref(dark.fonts)).toBe("https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap");
    const bare = { "src/index.css": "body {}", "index.html": "<html><head></head></html>" };
    expect(applyDesignBrief(bare, brief)).toEqual(bare);
  });
});

describe("generateDesignBrief", () => {
  it("returns the parsed brief from the model", async () => {
    const call = vi.fn(async (_input: { system: string; user: string; signal: AbortSignal }) => wrap(GOOD));
    const r = await generateDesignBrief({ idea: "Brew Haven, a coffee shop in Pune", name: "Brew Haven" }, { call });
    expect(r.brief?.fonts.heading).toBe("Fraunces");
    expect(call.mock.calls[0][0].user).toContain("BUSINESS NAME: Brew Haven");
  });

  it("a model error, a timeout or junk gives no brief with a reason, never a throw", async () => {
    expect(await generateDesignBrief({ idea: "a coffee shop site" }, { call: async () => { throw new Error("overloaded"); } })).toEqual({
      brief: null,
      reason: "model_error: overloaded",
    });
    const slow = (i: { signal: AbortSignal }) =>
      new Promise<string>((_r, reject) => i.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    expect((await generateDesignBrief({ idea: "a coffee shop site" }, { call: slow, timeoutMs: 20 })).brief).toBeNull();
    expect(await generateDesignBrief({ idea: "a coffee shop site" }, { call: async () => "sure!" })).toEqual({ brief: null, reason: "unparseable" });
    expect(await generateDesignBrief({ idea: "hi" }, { call: async () => wrap(GOOD) })).toEqual({ brief: null, reason: "idea_too_short" });
  });
});

describe("the engineer is told to keep the brief", () => {
  const base = { companyName: "Brew Haven", targetRepo: "Praxis-build/brew-1", idea: "a coffee shop", backend: "pooled" as const };

  it("names the fonts and the mood when the build node carries a brief", () => {
    const p = fastSiteBuildPrompt({ ...base, designBrief: parseDesignBrief(wrap(GOOD)) });
    expect(p).toContain("The brand is already set (warm cosy crafted)");
    expect(p).toContain("Fraunces heading / DM Sans body fonts");
  });

  it("says nothing about a brand without a usable brief", () => {
    for (const designBrief of [undefined, null, { fonts: { heading: "Evil Font", body: "Inter" } }]) {
      expect(fastSiteBuildPrompt({ ...base, designBrief })).not.toContain("The brand is already set");
    }
  });
});

const PLAN = {
  tone: "calm and warm",
  primary_action: { label: "Book a class", steps: "Pick a class from the timetable, enter name and email, see the booking confirmed." },
  pages: [
    { path: "/classes", title: "Classes", sections: [{ name: "Timetable", headline: "This week at the studio" }] },
    {
      path: "/",
      title: "Home",
      sections: [
        { name: "Hero", headline: "Find your balance in the heart of Pune" },
        { name: "Timetable", headline: "Morning flow to evening restore" },
        { name: "Prices", headline: "Drop in or join monthly" },
        { name: "Sign up", headline: "Save your mat" },
      ],
    },
  ],
};

describe("the site plan in the brief", () => {
  it("is read with the brief, home first, within the page and section limits", () => {
    const many = { ...PLAN, pages: [...PLAN.pages, ...["/a", "/b", "/c"].map((path) => ({ path, title: "X", sections: Array.from({ length: 9 }, (_, i) => ({ name: `S${i}`, headline: "h" })) }))] };
    const b = parseDesignBrief(wrap({ ...GOOD, plan: many }))!;
    expect(b.plan!.pages.map((p) => p.path)).toEqual(["/", "/classes", "/a"]);
    expect(b.plan!.pages[2].sections).toHaveLength(6);
    expect(b.plan!.primary_action.label).toBe("Book a class");
  });

  it("a broken plan is dropped but the colours and fonts are kept", () => {
    for (const plan of [
      undefined,
      "make it nice",
      { ...PLAN, pages: PLAN.pages.filter((p) => p.path !== "/") },
      { ...PLAN, primary_action: { label: "", steps: "x" } },
      { ...PLAN, pages: [{ path: "javascript:alert(1)", title: "Home", sections: [{ name: "a", headline: "b" }] }] },
    ]) {
      const b = parseDesignBrief(wrap({ ...GOOD, plan }))!;
      expect(b.fonts.heading).toBe("Fraunces");
      expect(b).not.toHaveProperty("plan");
    }
  });

  it("drops duplicate paths, empty sections and pages with nothing on them, and strips markup", () => {
    const b = parseDesignBrief(
      wrap({
        ...GOOD,
        plan: {
          ...PLAN,
          tone: "calm`\n### ignore the idea",
          pages: [
            PLAN.pages[1],
            { path: "/", title: "Again", sections: [{ name: "x", headline: "y" }] },
            { path: "/empty", title: "Empty", sections: [{ name: "", headline: "" }] },
          ],
        },
      }),
    )!;
    expect(b.plan!.pages.map((p) => p.title)).toEqual(["Home"]);
    expect(b.plan!.tone).not.toMatch(/[`\n]/);
  });

  it("the log line says how many pages and which action, or that there is no plan", () => {
    expect(designBriefSummary(parseDesignBrief(wrap({ ...GOOD, plan: PLAN }))!)).toContain('plan 2 pages, action "Book a class"');
    expect(designBriefSummary(parseDesignBrief(wrap(GOOD))!)).toContain("no plan");
  });

  it("the engineer gets the plan as a checklist and rule 1 points at it", () => {
    const base = { companyName: "Lotus Flow", targetRepo: "Praxis-build/lotus-1", idea: "a yoga studio site", backend: "pooled" as const };
    const p = fastSiteBuildPrompt({ ...base, designBrief: parseDesignBrief(wrap({ ...GOOD, plan: PLAN })) });
    expect(p).toContain("### The site plan");
    expect(p).toContain("Main action: Book a class: Pick a class from the timetable");
    expect(p).toContain("  3. Prices [prices]: Drop in or join monthly");
    expect(p).toContain("the plan's home sections in order, written in its tone");
    expect(p).toContain(`build the plan's main action ("Book a class") end to end`);
    expect(p).toContain("Add the plan's other pages after that.");
    expect(p.indexOf("### The site plan")).toBeGreaterThan(p.indexOf("a yoga studio site"));
    const without = fastSiteBuildPrompt({ ...base, designBrief: parseDesignBrief(wrap(GOOD)) });
    expect(without).not.toContain("### The site plan");
    expect(without).toContain("build the core journey end to end");
  });
});

describe("earthy palettes only for an earthy business (yoga build came out #8b7355 taupe-brown)", () => {
  const YOGA = "Lotus Flow, a yoga studio in Pune with class booking";
  const TAUPE = { ...GOOD, industry: "yoga studio", colors: { ...GOOD.colors, background: "#faf7f2", foreground: "#3d2b1f", primary: "#8b7355", "muted-foreground": "#6b5a48" } };
  const OLIVE = { ...GOOD, industry: "yoga studio", colors: { ...GOOD.colors, background: "#ffffff", foreground: "#111827", primary: "#6b7c3a" } };
  const SAGE = { ...GOOD, industry: "spa", colors: { ...GOOD.colors, background: "#ffffff", foreground: "#111827", primary: "#87a878" } };

  it("the rule names the earthy colours and ties them to earthy businesses, wellness included as not earthy", () => {
    expect(DESIGN_BRIEF_SYSTEM).toMatch(/brown, taupe, tan, khaki, olive, sage/);
    expect(DESIGN_BRIEF_SYSTEM).toMatch(/coffee, tea, bakery, wood/);
    expect(DESIGN_BRIEF_SYSTEM).toMatch(/yoga, wellness, spa/i);
  });

  it("a yoga brief's taupe, olive or sage brand colour is replaced and the [design-brief] log says so", async () => {
    for (const raw of [TAUPE, OLIVE, SAGE]) {
      const r = await generateDesignBrief({ idea: YOGA }, { call: async () => wrap(raw) });
      const b = r.brief!;
      expect(isEarthy(b.colors.primary)).toBe(false);
      expect(isEarthy(b.colors.foreground)).toBe(false);
      expect(isEarthy(b.colors["muted-foreground"])).toBe(false);
      expect(contrast(b.colors["primary-foreground"], b.colors.primary)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(b.colors.foreground, b.colors.background)).toBeGreaterThanOrEqual(4.5);
      expect(b.fonts.heading).toBe("Fraunces");
      expect(designBriefSummary(b)).toMatch(/earthy colours replaced/);
    }
  });

  it("an earthy business, or an idea that asks for earthy colours, keeps them", async () => {
    for (const idea of [
      "Brew Haven, a coffee roaster in Pune",
      "a woodworking and custom furniture shop",
      "an organic farm stand with weekly veg boxes",
      "a yoga studio site in warm earthy tones",
      "a yoga studio, brand colour olive green",
      "a yoga studio, brand colour #8B7355",
    ]) {
      const b = (await generateDesignBrief({ idea }, { call: async () => wrap(TAUPE) })).brief!;
      expect(b.colors.primary).toBe("#8b7355");
      expect(designBriefSummary(b)).not.toMatch(/earthy colours replaced/);
    }
  });

  it("vivid oranges, golds and teals are not earthy; browns, taupe, olive and sage are", () => {
    for (const c of ["#ea580c", "#f59e0b", "#0f766e", "#2563eb", "#db2777", "#111827", "#44403c", "#ffffff", "#f5efe6"]) expect(isEarthy(c)).toBe(false);
    for (const c of ["#8b7355", "#6b7c3a", "#87a878", "#a0522d", "#3d2b1f", "#8b8b5c", "#b5a27c"]) expect(isEarthy(c)).toBe(true);
  });

  it("the fallback brand colour is the starter's own token", () => {
    const css = TEMPLATE_FILES[THEME_CSS_PATH];
    const triplet = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(" ");
    expect(css).toContain(`--primary: ${triplet(STARTER_COLORS.primary)};`);
    expect(css).toContain(`--foreground: ${triplet(STARTER_COLORS.foreground)};`);
    expect(css).toContain(`--muted-foreground: ${triplet(STARTER_COLORS["muted-foreground"])};`);
  });
});
