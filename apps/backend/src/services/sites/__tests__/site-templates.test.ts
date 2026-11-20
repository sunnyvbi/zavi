import { describe, expect, it } from "vitest";
import { getThemePreset, resolveTheme } from "@/services/provisioning/templates/vite-react-zavi/theme-presets";
import { PLAN_MAX_SECTIONS, designBriefUserMessage, parseSitePlan, type DesignBrief, type SitePlan } from "../design-brief";
import { designDirections, lookIsGiven, withCompleteLook } from "../design-directions";
import { planSectionId } from "../design-fidelity";
import { siteSetupMarker, SITE_SETUP_MARKER_KEY } from "@/services/agents/site-setup-marker";
import {
  SITE_TEMPLATES,
  applySiteTemplate,
  designBriefTemplateLines,
  getSiteTemplate,
  parseSiteTemplate,
  publicSiteTemplates,
  templateChoiceFrom,
  unfilledTemplateBlanks,
} from "../site-templates";

const COLORS = {
  background: "#ffffff",
  foreground: "#111111",
  muted: "#f2f2f2",
  "muted-foreground": "#555555",
  primary: "#0f766e",
  "primary-foreground": "#ffffff",
  border: "#e5e5e5",
};

function brief(sections: unknown[]): DesignBrief {
  const plan = parseSitePlan({
    tone: "clear",
    primary_action: { label: "Book now", steps: "Pick a time" },
    pages: [
      { path: "/", title: "Home", sections },
      { path: "/about", title: "About", sections: [{ name: "Story", headline: "How we started" }] },
    ],
  }) as SitePlan;
  return { industry: "x", mood: "calm clear warm", mode: "light", colors: COLORS, fonts: { heading: "DM Sans", body: "Inter" }, plan, look: { base: "clean", layout: "centered", alternates: ["luxe"] }, source: "model" };
}

const home = (b: DesignBrief) => b.plan!.pages.find((p) => p.path === "/")!.sections;

describe("the template catalog", () => {
  it("every template is well formed: a real preset, valid variants, a plan that fits, blanks to fill", () => {
    expect(SITE_TEMPLATES.length).toBeGreaterThanOrEqual(6);
    expect(new Set(SITE_TEMPLATES.map((t) => t.id)).size).toBe(SITE_TEMPLATES.length);
    for (const t of SITE_TEMPLATES) {
      expect(parseSiteTemplate(JSON.parse(JSON.stringify(t)))).toEqual(t);
      expect(getThemePreset(t.look.base)).toBeTruthy();
      expect(t.sections.length).toBeLessThanOrEqual(PLAN_MAX_SECTIONS);
      expect(t.sections.filter((s) => s.component === "Hero")).toHaveLength(1);
      expect(unfilledTemplateBlanks(t.idea).length).toBeGreaterThan(0);
      expect(t.sections.some((s) => s.component === "Testimonials" || s.component === "Stats")).toBe(false);
    }
  });

  it("rejects a malformed snapshot", () => {
    const t = SITE_TEMPLATES[0]!;
    expect(parseSiteTemplate(null)).toBeNull();
    expect(parseSiteTemplate({ ...t, look: { base: "nope", layout: "split" } })).toBeNull();
    expect(parseSiteTemplate({ ...t, sections: [{ ...t.sections[0], variant: "zigzag" }] })).toBeNull();
    expect(parseSiteTemplate({ ...t, sections: [] })).toBeNull();
    expect(getSiteTemplate(" PORTFOLIO ")?.id).toBe("portfolio");
    expect(getSiteTemplate("gone")).toBeNull();
  });

  it("the public gallery draws each template's structure in neutral greys, never its preset's colours", () => {
    const list = publicSiteTemplates();
    expect(list.map((t) => t.id)).toEqual(SITE_TEMPLATES.map((t) => t.id));
    for (const p of list) {
      const t = getSiteTemplate(p.id)!;
      const preset = resolveTheme(getThemePreset(t.look.base)!);
      const primary = preset.primary.replace("#", "");
      expect(p.theme_css).toContain('Theme "template"');
      expect(p.theme_css).not.toContain(primary);
      expect(p.preview.sections.map((s) => s.kind)).toEqual(t.sections.filter((s) => s.component !== "Hero").map((s) => s.component));
      expect(p.preview.primary_action).toBe(t.action.label);
    }
  });
});

describe("templateChoiceFrom", () => {
  const t = getSiteTemplate("book-a-service")!;
  it("no template builds without one; an unknown one and any bracket left are refused; a filled idea is fine", () => {
    expect(templateChoiceFrom(undefined, "anything")).toEqual({ ok: true, template: null });
    expect(templateChoiceFrom("", "anything")).toEqual({ ok: true, template: null });
    for (const bad of ["retired-template", 42, { id: t.id }]) expect(templateChoiceFrom(bad, "anything")).toMatchObject({ ok: false, code: "invalid_template" });
    const refused = templateChoiceFrom(t.id, t.idea);
    expect(refused).toMatchObject({ ok: false, code: "template_blanks" });
    if (!refused.ok) expect(refused.message).toContain("[type of business]");
    expect(templateChoiceFrom(t.id, "A website for my bike shop in [city]. We offer tune-ups from $40.")).toMatchObject({ ok: false, code: "template_blanks" });
    const filled = templateChoiceFrom(t.id, "A website for my bike repair shop in Leeds. We offer tune-ups from $40. Customers book a time online.");
    expect(filled).toEqual({ ok: true, template: t });
  });
});

describe("applySiteTemplate", () => {
  it("lays the template's order, components and variants on the model's own headlines (three business shapes)", () => {
    const cases: Array<[string, unknown[]]> = [
      [
        "book-a-service",
        [
          { name: "Welcome", headline: "Bike repairs while you wait", component: "Hero", variant: "centered", image: { subject: "mechanic at work", role: "hero" } },
          { name: "Questions", headline: "Before you drop it off", component: "FAQ" },
          { name: "Repairs", headline: "Punctures to full services", component: "Features", variant: "alternating" },
          { name: "Book", headline: "Book a slot", component: "CTA", variant: "split" },
        ],
      ],
      [
        "portfolio",
        [
          { name: "Hello", headline: "Hand-lettered signs", component: "Hero" },
          { name: "Contact", headline: "Commission a sign", component: "Contact" },
          { name: "Signs", headline: "Recent signs", component: "Gallery", variant: "grid" },
        ],
      ],
      [
        "menu-and-hours",
        [
          { name: "Top", headline: "Dumplings made this morning", component: "Hero", image: { subject: "steaming dumplings", role: "hero" } },
          { name: "Hours", headline: "Open six days", component: "HoursLocation" },
          { name: "Food", headline: "Today's menu", component: "Menu" },
          { name: "Catering", headline: "Feeding a crowd", component: "Features" },
        ],
      ],
    ];
    for (const [id, sections] of cases) {
      const t = getSiteTemplate(id)!;
      const input = brief(sections);
      const before = JSON.stringify(input);
      const out = applySiteTemplate(input, t);
      expect(JSON.stringify(input)).toBe(before);
      expect(out.look).toMatchObject({ base: t.look.base, layout: t.look.layout });
      expect(lookIsGiven(out)).toBe(true);
      expect(out.template).toEqual({ id: t.id, v: t.v });
      expect(home(out).map((s) => s.headline).sort()).toEqual(home(input).map((s) => s.headline).sort());
      const order = t.sections.map((s) => s.component);
      const placed = home(out).filter((s) => order.includes(s.component!));
      const ranks = placed.map((s) => order.indexOf(s.component!));
      expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
      for (const s of placed) {
        const slot = t.sections.find((x) => x.component === s.component)!;
        if (slot.variant) expect(s.variant).toBe(slot.variant);
      }
      expect(out.plan!.pages[1]).toEqual(input.plan!.pages[1]);
      expect(home(out).filter((s) => s.image)).toHaveLength(home(input).filter((s) => s.image).length);
      expect(parseSitePlan(out.plan)).toEqual(out.plan);
    }
  });

  it("a section the template has no place for is kept after the template's sections", () => {
    const out = applySiteTemplate(
      brief([
        { name: "Top", headline: "Dumplings made this morning", component: "Hero" },
        { name: "Catering", headline: "Feeding a crowd", component: "Features" },
        { name: "Food", headline: "Today's menu", component: "Menu" },
      ]),
      getSiteTemplate("menu-and-hours")!,
    );
    expect(home(out).map((s) => s.name)).toEqual(["Top", "Food", "Catering"]);
  });

  it("sections whose long names collide still get distinct ids (and the loop ends)", () => {
    const long = "A very long section name that keeps going past forty";
    const out = applySiteTemplate(
      brief([
        { name: "Top", headline: "Welcome", component: "Hero" },
        { name: long, headline: "one", component: "FAQ" },
        { name: long, headline: "two", component: "Contact" },
        { name: long, headline: "three", component: "Gallery" },
      ]),
      getSiteTemplate("portfolio")!,
    );
    const ids = home(out).map((s) => planSectionId(s.name));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("without a planned hero (or with no plan) only the look is set", () => {
    const t = getSiteTemplate("product-launch")!;
    const noHero = brief([{ name: "Features", headline: "What it does", component: "Features" }]);
    expect(applySiteTemplate(noHero, t).plan).toEqual(noHero.plan);
    const noPlan = { ...noHero, plan: undefined };
    expect(applySiteTemplate(noPlan, t)).toMatchObject({ look: { base: "midnight", layout: "bold" }, look_given: "template" });
  });

  it("the looks offered after a template still differ in layout, the recommended one in the template's", () => {
    for (const t of SITE_TEMPLATES) {
      const b = withCompleteLook(applySiteTemplate(brief([{ name: "Top", headline: "Welcome in", component: "Hero", image: { subject: "the place", role: "hero" } }]), t), t.good_for);
      const dirs = designDirections(b);
      expect(dirs[0]!.layout).toBe(t.look.layout);
      expect(new Set(dirs.map((d) => d.layout)).size).toBe(dirs.length);
    }
  });
});

describe("the brief's message and the setup snapshot", () => {
  it("the template's structure rides the user message, within a bounded size", () => {
    const longest = [...SITE_TEMPLATES].sort((a, b) => designBriefTemplateLines(b).length - designBriefTemplateLines(a).length)[0]!;
    const msg = designBriefUserMessage({ idea: "x".repeat(4000), name: "N".repeat(80), templateLines: designBriefTemplateLines(longest) });
    expect(msg).toContain(`STARTING TEMPLATE (the founder picked "${longest.label}")`);
    expect(msg.length).toBeLessThan(5600);
    expect(designBriefUserMessage({ idea: "A bakery" })).not.toContain("STARTING TEMPLATE");
  });

  it("a failed setup keeps the template snapshot for Retry", () => {
    const t = getSiteTemplate("community")!;
    const graph = [
      {
        payload: {
          [SITE_SETUP_MARKER_KEY]: { v: 1, retryable: true, company_name: "Acme", idea: "A club", max_usd: 5, first_build_free: false, reference_images: [], site_template: JSON.parse(JSON.stringify(t)) },
        },
      },
    ];
    expect(parseSiteTemplate(siteSetupMarker(graph)!.site_template)).toEqual(t);
    const bad = [{ payload: { [SITE_SETUP_MARKER_KEY]: { v: 1, retryable: true, company_name: "Acme", idea: "A club", reference_images: [], site_template: "community" } } }];
    expect(siteSetupMarker(bad)!.site_template).toBeUndefined();
  });
});
