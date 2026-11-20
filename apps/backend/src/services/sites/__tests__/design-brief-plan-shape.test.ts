import { describe, expect, it } from "vitest";
import { THEME_CSS_PATH } from "@/services/provisioning/templates/vite-react-zavi/theme-presets";
import { TEMPLATE_FILES } from "@/services/provisioning/templates/vite-react-zavi/template-files.generated";
import { DESIGN_BRIEF_SYSTEM, PLAN_MAX_IMAGES, PLAN_MAX_PAGES, PLAN_MAX_SECTIONS, PLAN_SECTION_VARIANTS, clampFocal, isSocialProof, parseBriefExtras, parseDesignBrief, parsePlanImage, parseSitePlan } from "../design-brief";
import { applyDirectionToFiles, designDirections, fallbackDesignBrief } from "../design-directions";

const plan = (sections: unknown[]) => ({
  tone: "calm",
  primary_action: { label: "Book a check-up", steps: "Pick a time, leave a name, get a confirmation." },
  pages: [{ path: "/", title: "Home", sections }],
});
const one = (section: Record<string, unknown>) => parseSitePlan(plan([{ name: "Hero", headline: "Gentle dentistry", ...section }]))!.pages[0]!.sections[0]!;

describe("parseSitePlan section shape", () => {
  it("keeps a valid component, variant, tone and image, canonicalising case", () => {
    const s = one({
      component: "features",
      variant: "SPLIT",
      tone: "Muted",
      image: { role: "Service", aspect: "4:5", subject: "a hygienist cleaning teeth", placement: "Left", overlay: false, focal: { x: 30, y: 25 } },
    });
    expect(s).toEqual({
      name: "Hero",
      headline: "Gentle dentistry",
      component: "Features",
      variant: "split",
      tone: "muted",
      image: { subject: "a hygienist cleaning teeth", role: "service", aspect: "4:5", placement: "left", overlay: false, focal: { x: 30, y: 25 } },
    });
  });

  it("drops an unknown component and the variant it would have needed", () => {
    const s = one({ component: "Carousel", variant: "split" });
    expect(s.component).toBeUndefined();
    expect(s.variant).toBeUndefined();
  });

  it("drops a variant that belongs to another component", () => {
    expect(one({ component: "Hero", variant: "masonry" })).not.toHaveProperty("variant");
    expect(one({ component: "Gallery", variant: "editorial" })).not.toHaveProperty("variant");
    expect(one({ component: "CTA", variant: "split" }).variant).toBe("split");
    expect(one({ component: "FAQ", variant: "cards" })).toEqual({ name: "Hero", headline: "Gentle dentistry", component: "FAQ" });
  });

  it("validates tone and never gives Hero one", () => {
    expect(one({ component: "Hero", variant: "editorial", tone: "inverse" })).not.toHaveProperty("tone");
    expect(one({ component: "Stats", tone: "loud" })).not.toHaveProperty("tone");
    expect(one({ tone: "inverse" }).tone).toBe("inverse");
  });

  it("clamps the focal point and drops a broken one", () => {
    expect(one({ image: { subject: "a dental chair", focal: { x: 140, y: -5.4 } } }).image!.focal).toEqual({ x: 100, y: 0 });
    expect(one({ image: { subject: "a dental chair", focal: { x: "50", y: 20 } } }).image).not.toHaveProperty("focal");
    expect(one({ image: { subject: "a dental chair", focal: { x: Number.NaN, y: 20 } } }).image).not.toHaveProperty("focal");
    expect(clampFocal({ x: 49.6, y: 100.2 })).toEqual({ x: 50, y: 100 });
    expect(clampFocal(null)).toBeUndefined();
  });

  it("validates the image role, aspect and overlay field by field", () => {
    const img = one({ image: { subject: "  a   bright  reception  ", role: "billboard", aspect: "3:2", overlay: "yes", placement: "subject right, copy left" } }).image!;
    expect(img).toEqual({ subject: "a bright reception" });
    expect(one({ image: { subject: "y".repeat(200), placement: "FULL" } }).image).toEqual({ subject: "y".repeat(60), placement: "full" });
    expect(parsePlanImage({ subject: "a smile", role: "people", aspect: "16:9", overlay: true })).toEqual({ subject: "a smile", role: "people", aspect: "16:9", overlay: true });
  });

  it("drops an image with no subject and never throws on junk", () => {
    expect(one({ image: { role: "hero", aspect: "16:9" } })).not.toHaveProperty("image");
    for (const junk of [null, 7, "x", [], { component: 5, variant: {}, tone: [], image: "photo" }]) {
      expect(() => parseSitePlan(plan([junk, { name: "Ok", headline: "Fine", image: junk }]))).not.toThrow();
    }
    expect(parseSitePlan(plan([{ name: "Ok", headline: "Fine", component: null, image: [] }]))!.pages[0]!.sections[0]).toEqual({ name: "Ok", headline: "Fine" });
  });

  it("an old plan with only name and headline parses exactly as before", () => {
    expect(one({})).toEqual({ name: "Hero", headline: "Gentle dentistry" });
  });

  it("survives the whole brief parse", () => {
    const raw = JSON.stringify({
      industry: "Dental clinic",
      mood: "calm, clean, kind",
      mode: "light",
      colors: { background: "#ffffff", foreground: "#0f172a", muted: "#f1f5f9", "muted-foreground": "#475569", primary: "#0e7490", "primary-foreground": "#ffffff", border: "#e2e8f0" },
      fonts: { heading: "Fraunces", body: "Inter" },
      plan: plan([{ name: "Hero", headline: "Gentle dentistry", component: "Hero", variant: "editorial", image: { subject: "a dentist", role: "hero", focal: { x: 70, y: 30 } } }]),
    });
    const brief = parseDesignBrief(`<brief_json>${raw}</brief_json>`)!;
    expect(brief.plan!.pages[0]!.sections[0]).toMatchObject({ component: "Hero", variant: "editorial", image: { role: "hero", focal: { x: 70, y: 30 } } });
  });
});

describe("DESIGN_BRIEF_SYSTEM", () => {
  it("offers every component and variant the parser accepts", () => {
    for (const [component, variants] of Object.entries(PLAN_SECTION_VARIANTS)) {
      expect(DESIGN_BRIEF_SYSTEM).toContain(variants.length ? `${component} ${variants.join("|")}` : component);
    }
  });

  it("stays within its budget and has no em dashes", () => {
    expect(DESIGN_BRIEF_SYSTEM.length).toBeLessThanOrEqual(7_800);
    expect(DESIGN_BRIEF_SYSTEM).not.toMatch(/—/);
  });
});

describe("a look switch is style only", () => {
  it("changes theme.css and nothing else, whatever layout the page uses", () => {
    const brief = fallbackDesignBrief({ idea: "A family dentist; patients book check-ups online." });
    const home = `import { Hero, Features, Gallery, CTA } from "../components/sections";\nexport default function Home() { return <><Hero variant="editorial" title="Hi" /><Features variant="split" title="T" items={[]} /><Gallery variant="feature" images={[]} /><CTA variant="split" title="Go" /></>; }\n`;
    const files = { ...TEMPLATE_FILES, "src/pages/Home.tsx": home };
    const dirs = designDirections(brief);
    expect(dirs.length).toBeGreaterThanOrEqual(2);
    const outs = dirs.map((d) => applyDirectionToFiles(files, brief, d));
    for (const out of outs) {
      expect(Object.keys(out).sort()).toEqual(Object.keys(files).sort());
      for (const path of Object.keys(files)) {
        if (path !== THEME_CSS_PATH) expect(out[path], path).toBe(files[path as keyof typeof files]);
      }
    }
    expect(new Set(outs.map((o) => o[THEME_CSS_PATH])).size).toBe(dirs.length);
  });
});

const BRIEF_REST = {
  industry: "Family dental clinic",
  mood: "calm, clean, kind",
  mode: "light",
  colors: { background: "#ffffff", foreground: "#0f172a", muted: "#f1f5f9", "muted-foreground": "#475569", primary: "#0e7490", "primary-foreground": "#ffffff", border: "#e2e8f0" },
  fonts: { heading: "Fraunces", body: "Inter" },
  audience: "Nervous adults and young families in north Leeds who want a gentle local dentist",
  positioning: "Unhurried appointments with a dentist who explains every step before it happens",
  facts: ["Check-ups and hygiene", "Whitening and Invisalign", "Open Saturdays", "Free parking", "NHS and private", "Online booking", "Emergency slots", "Headingley"],
  imagery: { subjects: ["a dentist with a patient", "a bright reception", "a hygienist at work", "a smiling family", "a calm treatment room"], style: "bright daylight, soft teal accents" },
  look: { base: "soft", layout: "split", alternates: ["clean", "bold"] },
};
const COMPONENTS = ["Hero", "Features", "Gallery", "Testimonials", "CTA", "Stats"] as const;
const PATHS = ["/", "/treatments", "/about"];
const oversizedPlan = () => ({
  tone: "calm, reassuring and plain spoken",
  primary_action: { label: "Book a check-up online today", steps: "Pick a treatment, choose a time that suits you, leave a name and phone number, and get a confirmation by text." },
  pages: PATHS.map((path, p) => ({
    path,
    title: `Page title ${p}`.padEnd(40, "x"),
    sections: COMPONENTS.map((component, i) => ({
      name: `Section ${p}-${i}`.padEnd(40, "n"),
      headline: `Headline ${p}-${i} `.padEnd(120, "h"),
      component,
      variant: PLAN_SECTION_VARIANTS[component][0] ?? "",
      tone: "muted",
      image: { role: "service", aspect: "4:5", subject: "s".repeat(200), placement: "p".repeat(200), overlay: true, focal: { x: 33, y: 66 } },
    })),
  })),
});
const estimateTokens = (text: string) => Math.ceil(text.length / 3.5);

describe("brief output budget (photos only on the home page, capped)", () => {
  it("keeps at most PLAN_MAX_IMAGES images, all on the home page, whatever the model sends", () => {
    const parsed = parseSitePlan(oversizedPlan())!;
    expect(parsed.pages).toHaveLength(PLAN_MAX_PAGES);
    expect(parsed.pages.every((pg) => pg.sections.length === PLAN_MAX_SECTIONS)).toBe(true);
    const withImage = parsed.pages.flatMap((pg) => pg.sections.filter((x) => x.image).map(() => pg.path));
    expect(withImage).toEqual(Array(PLAN_MAX_IMAGES).fill("/"));
    expect(parsed.pages[0]!.sections.slice(0, PLAN_MAX_IMAGES).every((x) => x.image)).toBe(true);
    expect(parsed.pages[0]!.sections[0]!.image).toEqual({ subject: "s".repeat(60), role: "service", aspect: "4:5", overlay: true, focal: { x: 33, y: 66 } });
  });

  it("counts the cap from the home page even when the model lists it last", () => {
    const raw = oversizedPlan();
    raw.pages.reverse();
    const parsed = parseSitePlan(raw)!;
    expect(parsed.pages[0]!.path).toBe("/");
    expect(parsed.pages[0]!.sections.filter((x) => x.image)).toHaveLength(PLAN_MAX_IMAGES);
    expect(parsed.pages.slice(1).some((pg) => pg.sections.some((x) => x.image))).toBe(false);
  });

  it("the maximal allowed brief estimates (chars / 3.5) at 2000 tokens or fewer, leaving headroom under max_tokens 3000", () => {
    const maximal = { ...BRIEF_REST, plan: parseSitePlan(oversizedPlan()) };
    const text = `<brief_json>${JSON.stringify(maximal)}</brief_json>`;
    expect(estimateTokens(text)).toBeLessThanOrEqual(2000);
    expect(parseDesignBrief(text)!.plan!.pages).toHaveLength(PLAN_MAX_PAGES);
  });

  it("a reply cut off mid-plan yields null without throwing", () => {
    const text = `<brief_json>${JSON.stringify({ ...BRIEF_REST, plan: parseSitePlan(oversizedPlan()) })}</brief_json>`;
    for (const cut of [0.3, 0.6, 0.9, 0.99]) {
      expect(() => parseDesignBrief(text.slice(0, Math.floor(text.length * cut)))).not.toThrow();
      expect(parseDesignBrief(text.slice(0, Math.floor(text.length * cut)))).toBeNull();
    }
  });

  it("states the caps in the system prompt", () => {
    expect(DESIGN_BRIEF_SYSTEM).toContain("Only home-page sections may add image");
    expect(DESIGN_BRIEF_SYSTEM).toContain("placement (left|right|center|full");
    expect(DESIGN_BRIEF_SYSTEM).toContain(`at most ${PLAN_MAX_IMAGES} images`);
  });
});

describe("no invented social proof on a brand-new business", () => {
  const IDEA = "I run a home cleaning service in San Jose";
  const cleaning = () =>
    plan([
      { name: "Hero", headline: "Spotless homes, booked in a minute", component: "Hero" },
      { name: "Proof", headline: "Trusted by San Jose families", component: "Features", variant: "cards" },
      { name: "Numbers", headline: "500+ homes cleaned", component: "Stats" },
      { name: "Reviews", headline: "What our customers say", component: "Testimonials" },
      { name: "Years", headline: "10 years of experience", component: "Features" },
      { name: "Rated", headline: "Rated 5-star by neighbours", component: "Features" },
      { name: "Services", headline: "Deep cleans and weekly visits", component: "Features" },
      { name: "Book", headline: "Pick a time and review your booking", component: "CTA" },
    ]);

  it("drops every testimonial, rating, trusted-by, count and years line the idea did not give", () => {
    const names = parseSitePlan(cleaning(), IDEA)!.pages[0]!.sections.map((s) => s.name);
    expect(names).toEqual(["Hero", "Services", "Book"]);
  });

  it("the whole brief path drops them too, so a parsed brief never carries one", () => {
    const raw = `<brief_json>${JSON.stringify({
      industry: "cleaning",
      mood: "fresh calm tidy",
      mode: "light",
      colors: { background: "#ffffff", foreground: "#111111", muted: "#f2f2f2", "muted-foreground": "#555555", primary: "#0f766e", "primary-foreground": "#ffffff", border: "#e5e5e5" },
      fonts: { heading: "DM Sans", body: "Inter" },
      plan: cleaning(),
    })}</brief_json>`;
    const brief = parseDesignBrief(raw, { idea: IDEA })!;
    const text = brief.plan!.pages.flatMap((p) => p.sections.map((s) => `${s.component ?? ""} ${s.headline}`)).join(" | ");
    expect(text).not.toMatch(/trusted by|testimonial|stats|\d+\+|rated|years of|customers say/i);
  });

  it("a hero headline with invented proof loses the line but keeps the hero and its layout", () => {
    const hero = parseSitePlan(plan([{ name: "Hero", headline: "Trusted by San Jose families", component: "Hero", variant: "split" }]), IDEA)!.pages[0]!.sections[0]!;
    expect(hero).toMatchObject({ component: "Hero", variant: "split" });
    expect(isSocialProof(hero.headline)).toBe(false);
  });

  it("a hero headline the founder's own words back stays", () => {
    const idea = "Home cleaning in San Jose, trusted by San Jose families since 2012";
    const hero = parseSitePlan(plan([{ name: "Hero", headline: "Trusted by San Jose families", component: "Hero" }]), idea)!.pages[0]!.sections[0]!;
    expect(hero.headline).toBe("Trusted by San Jose families");
  });

  it("the positioning line drops invented proof, because the look preview shows it as the headline", () => {
    expect(parseBriefExtras({ positioning: "Trusted by San Jose families for 10 years" }, IDEA).positioning).toBeUndefined();
    expect(parseBriefExtras({ positioning: "Rated 5-star by neighbours" }, IDEA).positioning).toBeUndefined();
    expect(parseBriefExtras({ positioning: "Spotless homes, booked in a minute" }, IDEA).positioning).toBe("Spotless homes, booked in a minute");
    expect(parseBriefExtras({ positioning: "Trusted by San Jose families" }, "Cleaning, trusted by San Jose families").positioning).toBe("Trusted by San Jose families");
  });

  it("keeps proof the founder gave in the idea", () => {
    const idea = "Home cleaning in San Jose, 10 years of experience, 500+ homes cleaned, 120 reviews on Yelp";
    const names = parseSitePlan(cleaning(), idea)!.pages[0]!.sections.map((s) => s.name);
    expect(names).toContain("Numbers");
    expect(names).toContain("Years");
    expect(names).toContain("Reviews");
  });

  it("a stored plan read without the idea is left as it is", () => {
    expect(parseSitePlan(cleaning())!.pages[0]!.sections.map((s) => s.name)).toHaveLength(6);
  });
});
