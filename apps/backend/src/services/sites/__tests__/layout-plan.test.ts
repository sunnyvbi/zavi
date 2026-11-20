import { describe, expect, it } from "vitest";
import { parseSitePlan, parseBriefExtras, type DesignBrief, type SitePlan } from "../design-brief";
import { BRAND_DIRECTION_ID, briefForChosenLook, designDirections, fallbackDesignBrief, lookIsGiven, parseStoredDirections, withCompleteLook } from "../design-directions";
import { planForLayout, planHeroForLayout } from "../layout-plan";

const COLORS = {
  background: "#ffffff",
  foreground: "#111111",
  muted: "#f2f2f2",
  "muted-foreground": "#555555",
  primary: "#1d4ed8",
  "primary-foreground": "#ffffff",
  border: "#e5e5e5",
};

function plan(sections: unknown[], extraPages: unknown[] = []): SitePlan {
  return parseSitePlan({
    tone: "clear",
    primary_action: { label: "Get in touch", steps: "Pick a time and send the form" },
    pages: [{ path: "/", title: "Home", sections }, ...extraPages],
  })!;
}

const SHAPES: Record<string, { idea: string; brief: DesignBrief }> = {
  trade: {
    idea: "A plumbing and heating company serving three towns; customers request a quote online.",
    brief: {
      industry: "home services",
      mood: "trusted clear local",
      mode: "light",
      colors: COLORS,
      fonts: { heading: "DM Sans", body: "Inter" },
      look: { base: "trust", layout: "split", alternates: ["clean", "fresh"] },
      plan: plan([
        { name: "Hero", headline: "Heating fixed today", component: "Hero", variant: "split", image: { subject: "engineer at a boiler", role: "hero" } },
        { name: "Services", headline: "What we fix", component: "Features", variant: "cards" },
        { name: "Proof", headline: "Jobs done this year", component: "Stats" },
        { name: "Reviews", headline: "What neighbours say", component: "Testimonials", variant: "cards" },
        { name: "Quote", headline: "Get a quote", component: "CTA", variant: "banner" },
      ]),
      source: "model",
    },
  },
  portfolio: {
    idea: "Portfolio for an illustrator who takes commissions for book covers.",
    brief: {
      industry: "illustration",
      mood: "quiet expressive crafted",
      mode: "light",
      colors: COLORS,
      fonts: { heading: "Fraunces", body: "Inter" },
      look: { base: "studio", layout: "minimal", alternates: ["editorial", "luxe"] },
      plan: plan([
        { name: "Intro", headline: "Covers that sell the story", component: "Hero", variant: "minimal" },
        { name: "About", headline: "Twelve years of covers", component: "Features", variant: "split", image: { subject: "illustrator at desk", role: "people" } },
        { name: "Work", headline: "Selected covers", component: "Gallery", variant: "grid" },
        { name: "Commission", headline: "Start a commission", component: "CTA" },
      ]),
      imagery: { subjects: ["book cover artwork"], style: "flat light" },
      source: "model",
    },
  },
  app: {
    idea: "A budgeting app for students; download links and a waitlist, no photos please.",
    brief: {
      industry: "consumer app",
      mood: "fresh bright friendly",
      mode: "light",
      colors: COLORS,
      fonts: { heading: "Outfit", body: "Inter" },
      look: { base: "fresh", layout: "split", alternates: ["sunny", "midnight"] },
      imagery: { subjects: [], style: "" },
      plan: plan(
        [
          { name: "Hero", headline: "Budget in five minutes a week", component: "Hero", variant: "split" },
          { name: "Features", headline: "Built for student life", component: "Features", variant: "icons" },
          { name: "Numbers", headline: "Students saving", component: "Stats", tone: "inverse" },
          { name: "Join", headline: "Join the waitlist", component: "CTA" },
        ],
        [{ path: "/faq", title: "FAQ", sections: [{ name: "Questions", headline: "Common questions", component: "FAQ" }] }],
      ),
      source: "model",
    },
  },
};

const homeOf = (p: SitePlan) => p.pages.find((x) => x.path === "/")!.sections;

describe("each look has its own structure", () => {
  it.each(Object.keys(SHAPES))("%s: the three looks never share a layout, and each carries a plan for its layout", (key) => {
    const { idea, brief } = SHAPES[key]!;
    const dirs = designDirections(withCompleteLook(brief, idea));
    expect(dirs.length).toBeGreaterThanOrEqual(2);
    expect(new Set(dirs.map((d) => d.layout)).size).toBe(dirs.length);
    for (const d of dirs) expect(d.plan).toBeTruthy();
    const heroes = dirs.map((d) => homeOf(d.plan!).find((s) => s.component === "Hero")!.variant);
    expect(new Set(heroes).size).toBeGreaterThanOrEqual(2);
  });

  it("never offers two looks that would build the same page, even on a small plan two layouts arrange alike", () => {
    const small: DesignBrief = {
      ...SHAPES.trade!.brief,
      look: { base: "luxe", layout: "centered", alternates: ["midnight", "sunny"] },
      plan: plan([
        { name: "Hero", headline: "Open late every night", component: "Hero", image: { subject: "the counter at night", role: "hero" } },
        { name: "Questions", headline: "Before you visit", component: "FAQ" },
        { name: "Find us", headline: "Where we are", component: "Contact" },
      ]),
    };
    const dirs = designDirections(withCompleteLook(small, "A late-night noodle bar with a short menu."));
    const shapes = dirs.map((d) => JSON.stringify(homeOf(d.plan!).map((x) => [x.name, x.variant ?? "", x.tone ?? ""])));
    expect(new Set(shapes).size).toBe(dirs.length);
  });

  it("a brief with no photos never gets a split look (it would render as centered)", () => {
    const { idea, brief } = SHAPES.app!;
    const dirs = designDirections(withCompleteLook(brief, idea));
    expect(dirs[0]!.layout).toBe("centered");
    expect(dirs.some((d) => d.layout === "split")).toBe(false);
  });

  it("the fallback brief (no plan) still offers looks with distinct layouts and no invented plan", () => {
    for (const { idea } of Object.values(SHAPES)) {
      const dirs = designDirections(withCompleteLook(fallbackDesignBrief({ idea }), idea));
      expect(new Set(dirs.map((d) => d.layout)).size).toBe(dirs.length);
      expect(dirs.every((d) => d.plan === undefined)).toBe(true);
    }
  });

  it("stored looks keep their plan, so a later change to the rules never reshapes a built site", () => {
    const dirs = designDirections(withCompleteLook(SHAPES.trade!.brief, SHAPES.trade!.idea));
    const back = parseStoredDirections(JSON.parse(JSON.stringify(dirs)));
    expect(back.map((d) => d.plan)).toEqual(dirs.map((d) => d.plan));
  });
});

describe("planForLayout", () => {
  const trade = SHAPES.trade!.brief.plan!;

  it("only rearranges the sections the brief planned: none added, none dropped, other pages untouched", () => {
    for (const layout of ["split", "centered", "editorial", "bold", "minimal"] as const) {
      const out = planForLayout(SHAPES.app!.brief.plan!, layout);
      expect(homeOf(out).map((s) => s.name).sort()).toEqual(homeOf(SHAPES.app!.brief.plan!).map((s) => s.name).sort());
      expect(out.pages[1]).toEqual(SHAPES.app!.brief.plan!.pages[1]);
      expect(parseSitePlan(out)).toEqual(out);
    }
  });

  it("picks the hero for the layout, and a photo variant only when the hero has a photo", () => {
    expect(homeOf(planForLayout(trade, "centered"))[0]!.variant).toBe("image");
    expect(homeOf(planForLayout(trade, "editorial"))[0]!.variant).toBe("editorial");
    const noPhoto = SHAPES.app!.brief.plan!;
    expect(homeOf(planForLayout(noPhoto, "split"))[0]!.variant).toBe("centered");
    expect(homeOf(planForLayout(noPhoto, "centered"))[0]!.variant).toBe("centered");
  });

  it("no layout moves a Stats or Testimonials section to lead the page", () => {
    for (const layout of ["split", "centered", "editorial", "bold", "minimal"] as const) {
      expect(homeOf(planForLayout(trade, layout)).map((s) => s.name)).toEqual(["Hero", "Services", "Proof", "Reviews", "Quote"]);
    }
    const folio = SHAPES.portfolio!.brief.plan!;
    expect(homeOf(planForLayout(folio, "minimal")).map((s) => s.name)).toEqual(["Intro", "Work", "About", "Commission"]);
  });

  it("sets variants and tones per layout, and a quiet layout drops dark bands", () => {
    const bold = homeOf(planForLayout(trade, "bold"));
    expect(bold.find((s) => s.name === "Proof")!.tone).toBe("inverse");
    expect(bold.find((s) => s.name === "Reviews")!.variant).toBe("quote");
    const minimal = homeOf(planForLayout(SHAPES.app!.brief.plan!, "minimal"));
    expect(minimal.some((s) => s.tone === "inverse")).toBe(false);
    expect(homeOf(planForLayout(SHAPES.portfolio!.brief.plan!, "editorial")).find((s) => s.name === "About")!.variant).toBe("split");
    expect(homeOf(planForLayout(trade, "editorial")).find((s) => s.name === "Services")!.variant).toBe("cards");
  });

  it("never plans a photo-row Features section without a planned photo", () => {
    for (const layout of ["split", "centered", "editorial", "bold", "minimal"] as const) {
      for (const shape of Object.values(SHAPES)) {
        const p = shape?.brief.plan;
        if (!p) continue;
        for (const s of homeOf(planForLayout(p, layout))) {
          if (s.component === "Features" && !s.image) expect([layout, s.name, s.variant]).not.toEqual([layout, s.name, "alternating"]);
        }
      }
    }
  });

  it("never reorders a page whose section names collide (their ids depend on order)", () => {
    const dup = plan([
      { name: "Hero", headline: "h", component: "Hero" },
      { name: "Work", headline: "a", component: "Features" },
      { name: "Work", headline: "b", component: "Gallery" },
    ]);
    expect(homeOf(planForLayout(dup, "minimal")).map((s) => s.headline)).toEqual(["h", "a", "b"]);
  });

  it("the recommended look keeps the brief's own section choices and only matches its hero", () => {
    const out = homeOf(planHeroForLayout(trade, "centered"));
    expect(out[0]!.variant).toBe("image");
    expect(out.slice(1)).toEqual(homeOf(trade).slice(1));
  });

  it("the recommended look turns a photo-less alternating Features section into cards, and keeps one with photos", () => {
    const p = plan([
      { name: "Hero", headline: "h", component: "Hero" },
      { name: "Why", headline: "w", component: "Features", variant: "alternating" },
      { name: "Work", headline: "k", component: "Features", variant: "alternating", image: { subject: "the team at work", role: "people" } },
    ]);
    const out = homeOf(planHeroForLayout(p, "split"));
    expect(out.find((s) => s.name === "Why")!.variant).toBe("cards");
    expect(out.find((s) => s.name === "Work")!.variant).toBe("alternating");
  });
});

describe("structure versus theme", () => {
  const { idea, brief } = SHAPES.trade!;
  const complete = withCompleteLook(brief, idea);
  const dirs = designDirections(complete);
  const other = dirs[1]!;

  it("before the build starts, the pick is both the structure and the theme", () => {
    const b = briefForChosenLook({ brief: complete, directions: dirs, chosen_direction: other.id });
    expect(b.look!.layout).toBe(other.layout);
    expect(b.plan).toEqual(other.plan);
    expect(b.colors.primary).not.toBe(complete.colors.primary);
  });

  it("after the build started, a new pick changes colours and fonts but never the structure", () => {
    const b = briefForChosenLook({ brief: complete, directions: dirs, chosen_direction: other.id, build_direction: BRAND_DIRECTION_ID });
    expect(b.look!.layout).toBe(dirs[0]!.layout);
    expect(b.plan).toEqual(dirs[0]!.plan);
    expect(b.mood).toBe(briefForChosenLook({ brief: complete, directions: dirs, chosen_direction: other.id }).mood);
  });
});

describe("only ask for a look when the request leaves it open", () => {
  it("keeps the model's claim only when its quote really is the founder's words", () => {
    const idea = "A yoga studio site, dark and moody with gold accents, class timetable and booking.";
    expect(parseBriefExtras({ visual_intent: { given: true, quote: "dark and moody with gold accents" } }, idea)).toMatchObject({
      direction_given: "dark and moody with gold accents",
      look_given: "idea",
    });
    expect(parseBriefExtras({ visual_intent: { given: true, quote: "minimal black and white" } }, idea).look_given).toBeUndefined();
    expect(parseBriefExtras({ visual_intent: { given: false, quote: "" } }, idea).look_given).toBeUndefined();
    expect(parseBriefExtras({ visual_intent: { given: true, quote: "dark and moody" } }).look_given).toBeUndefined();
  });

  it("lookIsGiven: the idea's words, reference images or a template, nothing else", () => {
    expect(lookIsGiven({})).toBe(false);
    expect(lookIsGiven({ look_given: "idea" })).toBe(true);
    expect(lookIsGiven({ look_given: "references" })).toBe(true);
    expect(lookIsGiven({ look_given: "template" })).toBe(true);
    expect(lookIsGiven({ look_given: "nope" as never })).toBe(false);
  });
});
