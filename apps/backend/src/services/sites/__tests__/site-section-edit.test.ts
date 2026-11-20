import { describe, expect, it } from "vitest";
import { applySectionOp, describeSection, pageFileForPath, type SectionFile } from "../site-section-edit";

const PLUMBER = `import { Contact, CTA, Features, Hero, Testimonials } from "../components/sections";

export default function Home() {
  return (
    <div data-zavi="home">
      <Hero data-zavi-section="hero" variant="split" title="Leaks fixed today" />
      <Features data-zavi-section="services" variant="cards" tone="muted" items={[]} />
      {/* social proof */}
      <Testimonials data-zavi-section="reviews" items={[]} />
      <CTA
        data-zavi-section="call-us"
        title="Call now"
      >
      </CTA>
      <Contact data-zavi-section="contact" />
    </div>
  );
}
`;

const SCHOOL = `import { Hero, Features, FAQ } from "../components/sections";
import { courses } from "../site";

export default function Home() {
  return (
    <main>
      <Hero data-zavi-section="hero" variant={"centered"} title="Learn Spanish" />
      {courses.map((c) => <Features key={c.id} data-zavi-section={c.id} items={c.items} />)}
      <FAQ data-zavi-section="faq" items={[]} />
    </main>
  );
}
`;

const ROASTER_HOME = `import { Hero as Top, Gallery } from "../components/sections";
import { Banner } from "../components/Banner";

export default function Home() {
  return (
    <>
      <Top data-zavi-section="hero" title="Small-batch beans" />
      <Banner data-zavi-section="promo" />
      <Gallery data-zavi-section="hero-gallery" variant="grid" images={[]} />
    </>
  );
}
`;

const ROASTER_SHOP = `import { Hero, Gallery } from "../components/sections";

export default function Shop() {
  return (
    <div>
      <Hero data-zavi-section="hero" variant="minimal" title="Shop" />
      <Gallery data-zavi-section="beans" images={[]} />
    </div>
  );
}
`;

const ROASTER_APP = `import { Route, Routes } from "react-router-dom";
import Home from "./pages/Home";
import Shop from "./pages/Shop";
export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/shop" element={<Page><Shop /></Page>} />
    </Routes>
  );
}
`;

const plumber: SectionFile[] = [{ path: "src/pages/Home.tsx", content: PLUMBER }];
const school: SectionFile[] = [{ path: "src/pages/Home.tsx", content: SCHOOL }];
const roaster: SectionFile[] = [
  { path: "src/pages/Home.tsx", content: ROASTER_HOME },
  { path: "src/pages/Shop.tsx", content: ROASTER_SHOP },
];

function done<T extends object>(r: T): Exclude<T, { error: unknown }> {
  if ("error" in r) throw new Error(`refused: ${String((r as { error: unknown }).error)}`);
  return r as Exclude<T, { error: unknown }>;
}

describe("describeSection", () => {
  it("reports layouts, tone and where it can move", () => {
    const info = done(describeSection(plumber, "services"));
    expect(info).toMatchObject({ component: "Features", variant: "cards", tone: "muted", can_move_up: true, can_move_down: true });
    expect(info.variants).toContain("alternating");
    expect(done(describeSection(plumber, "hero"))).toMatchObject({ component: "Hero", tones: [], can_move_up: false });
    expect(done(describeSection(plumber, "reviews")).can_move_up).toBe(true);
  });

  it("refuses what it cannot edit safely", () => {
    expect(describeSection(plumber, "nope")).toEqual({ error: "not_found" });
    expect(describeSection(roaster, "promo")).toEqual({ error: "not_a_section" });
    expect(done(describeSection(school, "faq")).can_move_up).toBe(false);
    expect(describeSection(plumber, "Bad Id")).toEqual({ error: "not_found" });
  });

  it("follows an aliased import to the starter component", () => {
    expect(done(describeSection(roaster, "hero-gallery")).component).toBe("Gallery");
  });
});

describe("applySectionOp", () => {
  it("replaces an existing layout literal", () => {
    const out = done(applySectionOp(plumber, { kind: "variant", section_id: "hero", variant: "editorial" }));
    expect(out.after).toContain('<Hero data-zavi-section="hero" variant="editorial" title="Leaks fixed today" />');
    expect(out.after.replace('variant="editorial"', 'variant="split"')).toBe(PLUMBER);
  });

  it("adds a missing prop and handles an expression literal", () => {
    const tone = done(applySectionOp(plumber, { kind: "tone", section_id: "reviews", tone: "inverse" }));
    expect(tone.after).toContain('<Testimonials tone="inverse" data-zavi-section="reviews"');
    const v = done(applySectionOp(school, { kind: "variant", section_id: "hero", variant: "minimal" }));
    expect(v.after).toContain('variant="minimal"');
  });

  it("refuses a variant or tone the component does not have", () => {
    expect(applySectionOp(plumber, { kind: "variant", section_id: "hero", variant: "carousel" })).toEqual({ error: "bad_variant" });
    expect(applySectionOp(plumber, { kind: "variant", section_id: "contact", variant: "cards" })).toEqual({ error: "bad_variant" });
    expect(applySectionOp(plumber, { kind: "tone", section_id: "hero", tone: "muted" })).toEqual({ error: "bad_tone" });
    expect(applySectionOp(plumber, { kind: "variant", section_id: "hero", variant: "split" })).toEqual({ error: "no_change" });
  });

  it("swaps a section with its neighbour, keeping the text between", () => {
    const out = done(applySectionOp(plumber, { kind: "move", section_id: "call-us", direction: "up" }));
    const order = [...out.after.matchAll(/data-zavi-section="([a-z-]+)"/g)].map((m) => m[1]);
    expect(order).toEqual(["hero", "services", "call-us", "reviews", "contact"]);
    expect(out.after).toContain("{/* social proof */}");
    expect(out.info.can_move_up).toBe(true);
    const down = done(applySectionOp(plumber, { kind: "move", section_id: "hero", direction: "down" }));
    expect([...down.after.matchAll(/data-zavi-section="([a-z-]+)"/g)].map((m) => m[1])).toEqual(["services", "hero", "reviews", "call-us", "contact"]);
    expect(applySectionOp(plumber, { kind: "move", section_id: "contact", direction: "down" })).toEqual({ error: "not_movable" });
  });

  it("uses the viewed page when two pages share an id", () => {
    expect(applySectionOp(roaster, { kind: "variant", section_id: "hero", variant: "split" })).toEqual({ error: "many_matches" });
    const page = pageFileForPath({ path: "src/App.tsx", content: ROASTER_APP }, "/shop/", roaster.map((f) => f.path));
    expect(page).toBe("src/pages/Shop.tsx");
    const out = done(applySectionOp(roaster, { kind: "variant", section_id: "hero", variant: "split" }, page));
    expect(out.path).toBe("src/pages/Shop.tsx");
    expect(pageFileForPath({ path: "src/App.tsx", content: ROASTER_APP }, "/", roaster.map((f) => f.path))).toBe("src/pages/Home.tsx");
    expect(pageFileForPath({ path: "src/App.tsx", content: ROASTER_APP }, "/missing", roaster.map((f) => f.path))).toBeNull();
  });

  it("refuses a computed variant", () => {
    const computed = [{ path: "src/pages/Home.tsx", content: PLUMBER.replace('variant="split"', "variant={style}") }];
    expect(applySectionOp(computed, { kind: "variant", section_id: "hero", variant: "minimal" })).toEqual({ error: "dynamic" });
  });
});
