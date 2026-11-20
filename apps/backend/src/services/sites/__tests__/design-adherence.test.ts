import { describe, expect, it, vi, beforeEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const getBoolSetting = vi.fn();
vi.mock("@/services/settings", () => ({ getBoolSetting: (...a: unknown[]) => getBoolSetting(...a) }));

import {
  checkDesignAdherence,
  isRedesignRequest,
  reportSiteDesignAdherence,
  sandboxHeadReader,
  MAX_ADHERENCE_FILE_BYTES,
  SPACING_DRIFT_MIN,
  type AdherenceFile,
  type AdherenceIntent,
  type DesignFinding,
  type HeadReader,
} from "../design-adherence";

const reader = (fn: (path: string) => string | null): HeadReader => async (paths) => new Map(paths.map((p) => [p, fn(p)]));

const HOME_BEFORE = `import { Contact, CTA, FAQ, Features, Hero, Testimonials } from "../components/sections";

export default function Home() {
  return (
    <div data-zavi="home">
      <Hero
        variant="centered"
        eyebrow="Neighbourhood bakery"
        title="Fresh sourdough every morning"
        subtitle="Baked before sunrise on Elm Street."
        image={{ src: "/images/hero-loaves.jpg", alt: "Loaves cooling on a rack" }}
        actions={[{ label: "Order bread", href: "#contact" }]}
      />
      <Features
        variant="cards"
        tone="muted"
        title="What we bake"
        items={[
          { title: "Sourdough", body: "Three-day ferment." },
          { title: "Pastries", body: "Butter laminated by hand." },
        ]}
      />
      <FAQ title="Questions" items={[{ q: "Do you deliver?", a: "Within two miles." }]} />
      <CTA variant="banner" title="Pre-order for the weekend" action={{ label: "Order", href: "#contact" }} />
      <Contact tone="muted" />
    </div>
  );
}
`;

const SITE_BEFORE = `import type { Action, NavItem } from "./components/sections";

export const SITE: { name: string; tagline: string; nav: NavItem[]; cta?: Action } = {
  name: "Elm Street Bakery",
  tagline: "Sourdough baked before sunrise.",
  nav: [
    { label: "Menu", href: "/#menu" },
    { label: "Contact", href: "/#contact" },
  ],
  cta: { label: "Order bread", href: "/#contact" },
};
`;

const INDEX_CSS_BEFORE = `@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
}

@layer base {
  body {
    @apply bg-background font-body text-foreground antialiased;
  }
}
`;

const APP_BEFORE = `import { Route, Routes } from "react-router-dom";
import { SiteHeader, SiteFooter } from "./components/sections";
import { SITE } from "./site";
import Home from "./pages/Home";
import Login from "./pages/Login";

export default function App() {
  return (
    <>
      <SiteHeader name={SITE.name} links={SITE.nav} cta={SITE.cta} />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/login" element={<Login />} />
      </Routes>
      <SiteFooter name={SITE.name} />
    </>
  );
}
`;

function mod(path: string, before: string, after: string): AdherenceFile {
  return { path, action: "modify", before, after };
}

function run(files: AdherenceFile[], intent: Partial<AdherenceIntent> = {}) {
  return checkDesignAdherence({ files, intent: { scope: "tweak", redesign: false, ...intent } });
}

function warns(findings: DesignFinding[], kind?: DesignFinding["kind"]) {
  return findings.filter((f) => f.severity === "warn" && (!kind || f.kind === kind));
}

function lineOf(source: string, needle: string): number {
  return source.slice(0, source.indexOf(needle)).split("\n").length;
}

describe("raw colours", () => {
  it("flags a Tailwind palette class added to a page, with its line, and nothing already there", () => {
    const after = HOME_BEFORE.replace('<FAQ title="Questions"', '<FAQ className="bg-blue-500" title="Questions"');
    const r = run([mod("src/pages/Home.tsx", HOME_BEFORE, after)]);
    const w = warns(r.findings, "raw_color");
    expect(w).toEqual([{ kind: "raw_color", file: "src/pages/Home.tsx", line: lineOf(after, "bg-blue-500"), evidence: "bg-blue-500", severity: "warn" }]);
    expect(r.warn.raw_color).toBe(1);
  });

  it("counts only new uses: a palette class the page already had once and now has twice is one finding", () => {
    const before = HOME_BEFORE.replace('<FAQ title="Questions"', '<FAQ className="bg-amber-100" title="Questions"');
    const after = before.replace('<Contact tone="muted" />', '<Contact className="bg-amber-100" tone="muted" />');
    const r = run([mod("src/pages/Home.tsx", before, after)]);
    expect(warns(r.findings, "raw_color")).toHaveLength(1);
    expect(warns(r.findings, "raw_color")[0].line).toBe(lineOf(after, '<Contact className="bg-amber-100"'));
  });

  it("flags arbitrary hex and rgb classes, cn() strings and inline style colours, but not theme tokens or a #contact anchor", () => {
    const after = HOME_BEFORE.replace(
      '<Contact tone="muted" />',
      `<section className={cn("py-12 text-[#ff6600]", open && "hover:bg-[rgb(10,20,30)]")} style={{ color: "#333333", borderColor: "rgb(var(--border))" }}>
        <a href="#cafe" className="bg-primary text-primary-foreground">Visit the cafe</a>
      </section>
      <Contact tone="muted" />`,
    );
    const ev = warns(run([mod("src/pages/Home.tsx", HOME_BEFORE, after)]).findings, "raw_color").map((f) => f.evidence).sort();
    expect(ev).toEqual(["hover:bg-[rgb(10,20,30)]", "style color: #333333", "text-[#ff6600]"]);
  });

  it("flags a hex literal in index.css outside :root, and reports a :root token override in index.css as the sanctioned path", () => {
    const after = INDEX_CSS_BEFORE.replace(":root {\n}", ":root {\n  --primary: 190 18 60;\n  --accent: #f4e1c1;\n}\n\n.promo-band {\n  background: #ff0000;\n}");
    const r = run([mod("src/index.css", INDEX_CSS_BEFORE, after)], { scope: "theme" });
    expect(warns(r.findings)).toEqual([
      { kind: "raw_color", file: "src/index.css", line: lineOf(after, "background: #ff0000"), evidence: "background: #ff0000", severity: "warn" },
    ]);
    const info = r.findings.filter((f) => f.severity === "info");
    expect(info.map((f) => f.evidence)).toEqual(["--primary: 190 18 60", "--accent: #f4e1c1"]);
    expect(info.every((f) => f.exception === "theme token override in the :root block of src/index.css")).toBe(true);
  });

  it("the :root exception is index.css only: the same override in another stylesheet warns", () => {
    const r = run([{ path: "src/styles/promo.css", action: "create", before: null, after: ":root {\n  --primary: 190 18 60;\n}\n" }]);
    expect(warns(r.findings, "raw_color")).toHaveLength(1);
  });

  it("an image scrim over a photo is info, a black text class elsewhere is a warning", () => {
    const after = HOME_BEFORE.replace(
      '<Contact tone="muted" />',
      `<div className="relative">
        <SiteImage src="/images/hero-loaves.jpg" alt="Loaves" />
        <div className="absolute inset-0 bg-black/40" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/70 to-transparent" />
        <p className="absolute bottom-4 left-4 text-white">Baked today</p>
      </div>
      <p className="text-black">Plain text</p>
      <Contact tone="muted" />`,
    );
    const r = run([mod("src/pages/Home.tsx", HOME_BEFORE, after)], { scope: "section", founderStyleRequest: "add a photo strip" });
    const raw = r.findings.filter((f) => f.kind === "raw_color");
    expect(raw.filter((f) => f.severity === "info").map((f) => f.evidence).sort()).toEqual(["bg-black/40", "from-black/70", "text-white"]);
    expect(raw.filter((f) => f.severity === "info").every((f) => f.exception === "image overlay or scrim colour")).toBe(true);
    expect(warns(raw).map((f) => f.evidence)).toEqual(["text-black"]);
  });

  it("a coloured overlay that is not a dark or light scrim still warns", () => {
    const after = HOME_BEFORE.replace('<Contact tone="muted" />', '<div className="absolute inset-0 bg-rose-500/40" />\n      <Contact tone="muted" />');
    expect(warns(run([mod("src/pages/Home.tsx", HOME_BEFORE, after)]).findings, "raw_color").map((f) => f.evidence)).toEqual(["bg-rose-500/40"]);
  });

  it("chart files keep their series colours as info, by name or by chart library import", () => {
    const chart = `import { Bar, BarChart } from "recharts";
export function Sales({ data }: { data: { m: string; v: number }[] }) {
  return <BarChart data={data}><Bar dataKey="v" fill="#8884d8" /></BarChart>;
}
`;
    const r = run(
      [
        { path: "src/components/SalesChart.tsx", action: "create", before: null, after: chart.replace("recharts", "./bars") },
        { path: "src/components/Sales.tsx", action: "create", before: null, after: chart },
      ],
      { scope: "section" },
    );
    const raw = r.findings.filter((f) => f.kind === "raw_color");
    expect(raw).toHaveLength(2);
    expect(raw.every((f) => f.severity === "info" && f.exception === "chart or data visualisation colours")).toBe(true);
  });

  it("a colour the founder named is info, another colour in the same change still warns", () => {
    const after = HOME_BEFORE.replace(
      '<CTA variant="banner"',
      '<CTA className="bg-green-600 text-red-500" variant="banner"',
    );
    const r = run([mod("src/pages/Home.tsx", HOME_BEFORE, after)], { founderStyleRequest: "make the order button green" });
    const raw = r.findings.filter((f) => f.kind === "raw_color");
    expect(raw.find((f) => f.evidence === "bg-green-600")).toMatchObject({ severity: "info", exception: "the founder asked for green" });
    expect(raw.find((f) => f.evidence === "text-red-500")).toMatchObject({ severity: "warn" });
  });

  it("a hex the founder pasted is info", () => {
    const after = HOME_BEFORE.replace('<FAQ title="Questions"', '<FAQ className="bg-[#1D4ED8]" title="Questions"');
    const r = run([mod("src/pages/Home.tsx", HOME_BEFORE, after)], { founderStyleRequest: "use #1d4ed8 for the faq background" });
    expect(r.findings.filter((f) => f.kind === "raw_color")).toEqual([
      expect.objectContaining({ severity: "info", exception: "the founder asked for #1d4ed8" }),
    ]);
  });

  it("ignores platform files, and library files the edit did not change, but checks a library file it did change", () => {
    const button = `export const buttonVariants = "bg-primary text-primary-foreground";\n`;
    const r = run([
      { path: "src/theme.css", action: "modify", before: ":root {\n  --primary: 37 99 235;\n}\n", after: ":root {\n  --primary: #ff0000;\n  font-family: Comic Sans;\n}\n" },
      { path: "src/zavi/client.ts", action: "modify", before: "", after: 'const c = "bg-red-500";\n' },
      { path: "src/components/ui/card.tsx", action: "modify", before: 'const c = "bg-red-500";\n', after: 'const c = "bg-red-500";\n' },
      { path: "src/components/ui/button.tsx", action: "modify", before: button, after: button.replace("bg-primary", "bg-indigo-600") },
    ]);
    expect(r.findings).toEqual([expect.objectContaining({ file: "src/components/ui/button.tsx", evidence: "bg-indigo-600", severity: "warn" })]);
    expect(r.checked).toBe(1);
  });
});

describe("font changes", () => {
  it("flags a font-family rule, a Google Fonts import, a :root font token and an arbitrary font class, never a weight", () => {
    const css = INDEX_CSS_BEFORE.replace("@tailwind base;", '@import url("https://fonts.googleapis.com/css2?family=Lobster&display=swap");\n@tailwind base;')
      .replace(":root {\n}", ':root {\n  --font-display: "Lobster", cursive;\n}\n\n.tagline {\n  font-family: "Lobster", cursive;\n}');
    const page = HOME_BEFORE.replace('<FAQ title="Questions"', `<FAQ className="font-['Lobster'] font-[600]" title="Questions"`);
    const r = run([mod("src/index.css", INDEX_CSS_BEFORE, css), mod("src/pages/Home.tsx", HOME_BEFORE, page)]);
    const ev = warns(r.findings, "font_change").map((f) => f.evidence);
    expect(ev).toHaveLength(4);
    expect(ev.some((e) => e.startsWith("@import url(\"https://fonts.googleapis.com"))).toBe(true);
    expect(ev).toContain('--font-display: "Lobster", cursive');
    expect(ev).toContain('font-family: "Lobster", cursive');
    expect(ev).toContain("font-['Lobster']");
  });

  it("flags a font link added to index.html", () => {
    const before = "<!doctype html>\n<html>\n<head>\n<title>Elm Street Bakery</title>\n</head>\n<body></body>\n</html>\n";
    const after = before.replace("</head>", '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Pacifico">\n</head>');
    expect(warns(run([mod("index.html", before, after)]).findings, "font_change")).toEqual([
      expect.objectContaining({ file: "index.html", line: 5 }),
    ]);
  });

  it("is info when the founder asked for a font, or for a redesign", () => {
    const css = INDEX_CSS_BEFORE.replace(":root {\n}", ':root {\n  --font-display: "Playfair Display", serif;\n}');
    const asked = run([mod("src/index.css", INDEX_CSS_BEFORE, css)], { scope: "theme", founderStyleRequest: "use a serif font for headings" });
    expect(asked.findings).toEqual([expect.objectContaining({ kind: "font_change", severity: "info", exception: "the founder asked for a font change" })]);
    const redesign = run([mod("src/index.css", INDEX_CSS_BEFORE, css)], { scope: "theme", redesign: true, founderStyleRequest: "give it a new look" });
    expect(redesign.findings).toEqual([expect.objectContaining({ kind: "font_change", severity: "info", exception: "the founder asked for a redesign" })]);
  });
});

describe("spacing", () => {
  const spaced = (n: number) => {
    const values = ["p-[13px]", "mt-[37px]", "gap-[22px]", "px-[9px]", "mb-[41px]"].slice(0, n);
    return HOME_BEFORE.replace('<FAQ title="Questions"', `<FAQ className="${values.join(" ")}" title="Questions"`);
  };

  it(`stays quiet below ${SPACING_DRIFT_MIN} one-off values and reports at the threshold`, () => {
    expect(run([mod("src/pages/Home.tsx", HOME_BEFORE, spaced(SPACING_DRIFT_MIN - 1))]).findings).toEqual([]);
    const at = run([mod("src/pages/Home.tsx", HOME_BEFORE, spaced(SPACING_DRIFT_MIN))]);
    expect(warns(at.findings, "spacing_drift")).toEqual([
      expect.objectContaining({ file: "src/pages/Home.tsx", evidence: "3 one-off spacing values: p-[13px], mt-[37px], gap-[22px]" }),
    ]);
  });

  it("does not count spacing values the file already had", () => {
    const before = spaced(SPACING_DRIFT_MIN);
    const after = before.replace("<Contact", '<Contact className="p-[13px]"');
    expect(run([mod("src/pages/Home.tsx", before, after)]).findings).toEqual([]);
  });

  it("counts margins put between top-level sections (sections own the rhythm)", () => {
    const after = HOME_BEFORE.replace('<FAQ title', '<FAQ className="mt-16" title')
      .replace('<CTA variant', '<CTA className="mt-24" variant')
      .replace('<Contact tone', '<Contact className="mb-12" tone');
    const w = warns(run([mod("src/pages/Home.tsx", HOME_BEFORE, after)]).findings, "spacing_drift");
    expect(w).toHaveLength(1);
    expect(w[0].evidence).toBe("3 one-off spacing values: FAQ mt-16, CTA mt-24, Contact mb-12");
  });

  it("adds up across files of one change", () => {
    const a = HOME_BEFORE.replace('<FAQ title', '<FAQ className="p-[13px] mt-[37px]" title');
    const b = 'export function Promo() {\n  return <div className="py-[19px]">Hi</div>;\n}\n';
    const w = warns(run([mod("src/pages/Home.tsx", HOME_BEFORE, a), { path: "src/components/Promo.tsx", action: "create", before: null, after: b }], { scope: "section" }).findings, "spacing_drift");
    expect(w.map((f) => f.file).sort()).toEqual(["src/components/Promo.tsx", "src/pages/Home.tsx"]);
  });
});

describe("structure drift by scope", () => {
  const navAfter = SITE_BEFORE.replace('{ label: "Contact", href: "/#contact" },', '{ label: "Contact", href: "/#contact" },\n    { label: "Catering", href: "/catering" },');

  it("a tweak that changes the navigation is drift; one that asks about the menu link is not", () => {
    const drift = run([mod("src/site.ts", SITE_BEFORE, navAfter)], { founderStyleRequest: "change the headline to 'Bread worth waking for'" });
    expect(warns(drift.findings, "structure_drift")).toEqual([
      expect.objectContaining({ file: "src/site.ts", evidence: "navigation links changed: +/catering" }),
    ]);
    const asked = run([mod("src/site.ts", SITE_BEFORE, navAfter)], { founderStyleRequest: "add a Catering link to the menu" });
    expect(asked.findings).toEqual([]);
  });

  it("a theme change never moves navigation, even when it mentions the header", () => {
    const r = run([mod("src/site.ts", SITE_BEFORE, navAfter)], { scope: "theme", founderStyleRequest: "make the header and the whole site darker" });
    expect(warns(r.findings, "structure_drift")).toHaveLength(1);
  });

  it("a tweak that adds, removes or reorders sections is drift, each reported", () => {
    const reordered = HOME_BEFORE.replace(
      /      <FAQ[^\n]*\n      <CTA[^\n]*\n/,
      (m) => m.split("\n").filter(Boolean).reverse().join("\n") + "\n",
    ).replace('<Contact tone="muted" />', '<Testimonials items={[]} />\n      <Contact tone="muted" />');
    const r = run([mod("src/pages/Home.tsx", HOME_BEFORE, reordered)], { founderStyleRequest: "change the faq title to 'Good to know'" });
    const ev = warns(r.findings, "structure_drift").map((f) => f.evidence);
    expect(ev).toEqual(["sections added: Testimonials", "sections reordered: Hero > Features > FAQ > CTA > Contact became Hero > Features > CTA > FAQ > Testimonials > Contact"]);
  });

  it("a theme switch that changes a section layout variant is drift", () => {
    const after = HOME_BEFORE.replace('variant="centered"', 'variant="split"');
    const r = run([mod("src/pages/Home.tsx", HOME_BEFORE, after)], { scope: "theme", founderStyleRequest: "switch to the dark theme" });
    expect(warns(r.findings, "structure_drift").map((f) => f.evidence)).toEqual(["section layout changed: Hero variant centered -> split"]);
  });

  it("section markers identify sections even when wrapped", () => {
    const before = `export default function Home() {
  return (
    <main>
      <section data-zavi-section="hero" className="py-20"><h1>Hi</h1></section>
      <section data-zavi-section="menu" className="py-20"><h2>Menu</h2></section>
      <section data-zavi-section="visit" className="py-20"><h2>Visit</h2></section>
    </main>
  );
}
`;
    const after = before.replace(/      <section data-zavi-section="menu"[^\n]*\n/, "");
    const r = run([mod("src/pages/Home.tsx", before, after)], { founderStyleRequest: "change the hero heading to 'Hello'" });
    expect(warns(r.findings, "structure_drift").map((f) => f.evidence)).toEqual(["sections removed: menu"]);
  });

  it("section scope: its own section on the named page is fine, the same kind of change on another page is drift", () => {
    const home = HOME_BEFORE.replace('<Contact tone="muted" />', '<Testimonials items={[]} />\n      <Contact tone="muted" />');
    const aboutBefore = `import { Hero, Stats, CTA } from "../components/sections";
export default function About() {
  return (
    <div>
      <Hero variant="minimal" title="About us" />
      <Stats items={[]} />
      <CTA title="Visit" />
    </div>
  );
}
`;
    const aboutAfter = aboutBefore.replace("      <Stats items={[]} />\n", "");
    const r = run(
      [mod("src/pages/Home.tsx", HOME_BEFORE, home), mod("src/pages/About.tsx", aboutBefore, aboutAfter)],
      { scope: "section", founderStyleRequest: "add a testimonials section" },
    );
    expect(warns(r.findings, "structure_drift")).toEqual([
      expect.objectContaining({ file: "src/pages/About.tsx", evidence: "sections removed: Stats" }),
    ]);
  });

  it("section scope names its page: changes there pass, the home page is the other page", () => {
    const aboutBefore = `export default function About() {\n  return (\n    <div>\n      <Hero variant="minimal" title="About" />\n      <CTA title="Visit" />\n    </div>\n  );\n}\n`;
    const aboutAfter = aboutBefore.replace("      <CTA", "      <Testimonials items={[]} />\n      <CTA");
    const home = HOME_BEFORE.replace('<Contact tone="muted" />', '<Gallery items={[]} />\n      <Contact tone="muted" />');
    const r = run(
      [mod("src/pages/About.tsx", aboutBefore, aboutAfter), mod("src/pages/Home.tsx", HOME_BEFORE, home)],
      { scope: "section", founderStyleRequest: "add testimonials to the about page" },
    );
    expect(warns(r.findings, "structure_drift")).toEqual([expect.objectContaining({ file: "src/pages/Home.tsx", evidence: "sections added: Gallery" })]);
  });

  it("section scope on its own page still flags removing or reordering the other sections unless asked", () => {
    const removed = HOME_BEFORE.replace(/      <FAQ[^\n]*\n/, "").replace('<Contact tone="muted" />', '<Testimonials items={[]} />\n      <Contact tone="muted" />');
    const plain = run([mod("src/pages/Home.tsx", HOME_BEFORE, removed)], { scope: "section", founderStyleRequest: "add a testimonials section" });
    expect(warns(plain.findings, "structure_drift").map((f) => f.evidence)).toEqual(["sections removed: FAQ"]);
    const asked = run([mod("src/pages/Home.tsx", HOME_BEFORE, removed)], { scope: "section", founderStyleRequest: "replace the FAQ with testimonials" });
    expect(asked.findings).toEqual([]);
  });

  it("section scope lets a new in-page anchor into the nav, but not a removed link", () => {
    const anchor = SITE_BEFORE.replace('{ label: "Contact", href: "/#contact" },', '{ label: "Contact", href: "/#contact" },\n    { label: "Reviews", href: "/#reviews" },');
    expect(run([mod("src/site.ts", SITE_BEFORE, anchor)], { scope: "section", founderStyleRequest: "add a reviews section" }).findings).toEqual([]);
    const dropped = SITE_BEFORE.replace('    { label: "Menu", href: "/#menu" },\n', "");
    expect(warns(run([mod("src/site.ts", SITE_BEFORE, dropped)], { scope: "section", founderStyleRequest: "add a reviews section" }).findings)).toHaveLength(1);
  });

  it("page scope: the new page, its route and its nav link pass; the home page losing a section is drift", () => {
    const about = 'export default function About() {\n  return <div><Hero variant="minimal" title="About" /></div>;\n}\n';
    const app = APP_BEFORE.replace('<Route path="/login"', '<Route path="/about" element={<About />} />\n        <Route path="/login"');
    const nav = SITE_BEFORE.replace('{ label: "Contact", href: "/#contact" },', '{ label: "Contact", href: "/#contact" },\n    { label: "About", href: "/about" },');
    const home = HOME_BEFORE.replace(/      <FAQ[^\n]*\n/, "");
    const r = run(
      [
        { path: "src/pages/About.tsx", action: "create", before: null, after: about },
        mod("src/App.tsx", APP_BEFORE, app),
        mod("src/site.ts", SITE_BEFORE, nav),
        mod("src/pages/Home.tsx", HOME_BEFORE, home),
      ],
      { scope: "page", founderStyleRequest: "add an about page" },
    );
    expect(warns(r.findings, "structure_drift")).toEqual([expect.objectContaining({ file: "src/pages/Home.tsx", evidence: "sections removed: FAQ" })]);
  });

  it("page scope ignores everything on the page it was asked to change", () => {
    const home = HOME_BEFORE.replace(/      <FAQ[^\n]*\n/, "").replace('variant="centered"', 'variant="split"');
    expect(run([mod("src/pages/Home.tsx", HOME_BEFORE, home)], { scope: "page", founderStyleRequest: "rework the home page" }).findings).toEqual([]);
  });

  it("a tweak that adds a page or a route is drift", () => {
    const app = APP_BEFORE.replace('<Route path="/login"', '<Route path="/catering" element={<Home />} />\n        <Route path="/login"');
    const r = run([mod("src/App.tsx", APP_BEFORE, app), { path: "src/pages/Catering.tsx", action: "create", before: null, after: "export default function C() { return <div />; }\n" }]);
    expect(warns(r.findings, "structure_drift").map((f) => f.evidence).sort()).toEqual(["added page src/pages/Catering.tsx in a tweak change", "routes changed: +/catering"]);
  });

  it("a tweak that swaps an image is drift unless it asked about a photo", () => {
    const after = HOME_BEFORE.replace("/images/hero-loaves.jpg", "/images/hero-croissants.jpg");
    expect(warns(run([mod("src/pages/Home.tsx", HOME_BEFORE, after)], { founderStyleRequest: "make the headline bigger" }).findings, "structure_drift").map((f) => f.evidence)).toEqual([
      "images changed: +/images/hero-croissants.jpg -/images/hero-loaves.jpg",
    ]);
    expect(run([mod("src/pages/Home.tsx", HOME_BEFORE, after)], { founderStyleRequest: "use the croissant photo in the hero" }).findings).toEqual([]);
  });

  it("an explicit redesign suppresses every structure finding, and a first build has none", () => {
    const after = HOME_BEFORE.replace(/      <FAQ[^\n]*\n/, "").replace('variant="centered"', 'variant="split"');
    const files = [mod("src/pages/Home.tsx", HOME_BEFORE, after), mod("src/site.ts", SITE_BEFORE, navAfter)];
    expect(warns(run(files).findings, "structure_drift").length).toBeGreaterThan(1);
    expect(run(files, { redesign: true }).findings).toEqual([]);
    expect(run(files, { scope: "first_build" }).findings).toEqual([]);
  });
});

describe("limits", () => {
  it("skips a file over the size cap, a binary file and one whose previous version could not be read, and checks the rest", () => {
    const big = `const c = "bg-red-500";\n${"x".repeat(MAX_ADHERENCE_FILE_BYTES)}`;
    const r = run([
      { path: "src/pages/Big.tsx", action: "create", before: null, after: big },
      { path: "src/pages/Bin.tsx", action: "create", before: null, after: 'const c = "bg-red-500";\u0000' },
      { path: "public/images/hero.png", action: "create", before: null, after: "bg-red-500" },
      { path: "src/pages/Home.tsx", action: "modify", before: null, after: HOME_BEFORE.replace("<FAQ", '<FAQ className="bg-red-500"') },
      mod("src/pages/Ok.tsx", "", 'const c = "bg-red-500";\n'),
    ]);
    expect(r.skipped).toEqual([
      "src/pages/Big.tsx: too large or binary",
      "src/pages/Bin.tsx: too large or binary",
      "src/pages/Home.tsx: previous version unavailable",
    ]);
    expect(r.findings).toEqual([expect.objectContaining({ file: "src/pages/Ok.tsx" })]);
    expect(r.checked).toBe(1);
  });

  it("a page deleted in a tweak is drift and a malformed file never throws", () => {
    const r = run([
      { path: "src/pages/Menu.tsx", action: "delete", before: HOME_BEFORE, after: null },
      { path: "src/components/Broken.tsx", action: "create", before: null, after: "export default function ( { <div className=\"bg-red-500\"" },
      { path: "src/broken.css", action: "create", before: null, after: ".a { color: #fff; .b { " },
    ]);
    expect(warns(r.findings, "structure_drift").map((f) => f.evidence)).toEqual(["removed page src/pages/Menu.tsx in a tweak change"]);
  });
});

describe("isRedesignRequest", () => {
  it.each(["Redesign the site", "give it a completely new look", "try a different layout", "start over from scratch", "revamp the home page", "change the whole layout"])("%s", (t) => {
    expect(isRedesignRequest(t)).toBe(true);
  });
  it.each(["make the button blue", "switch to the dark theme", "change the layout of the footer text to bold", "add a gallery"])("not: %s", (t) => {
    expect(isRedesignRequest(t)).toBe(false);
  });
});

describe("reportSiteDesignAdherence", () => {
  const TENANT = "11111111-1111-4111-8111-111111111111";
  const payload = { site_id: "site-1", edit_size: "tweak", user_request: "make the headline bigger", idea: "ignored" };
  const files = [
    { path: "src/pages/Home.tsx", action: "modify" as const, diff: "", content: HOME_BEFORE.replace('<FAQ title', '<FAQ className="bg-blue-500" title').replace(/      <CTA[^\n]*\n/, "") },
    { path: "src/components/Promo.tsx", action: "create" as const, diff: "", content: 'export const P = () => <div className="text-[#ff0000]" />;\n' },
    { path: "src/theme.css", action: "modify" as const, diff: "", content: ":root{}" },
    { path: "public/images/a.png", action: "create" as const, diff: "", content: "AAAA", encoding: "base64" },
    { path: "supabase/migrations/001_x.sql", action: "create" as const, diff: "", content: "select 1;" },
  ];

  beforeEach(() => {
    getBoolSetting.mockReset();
  });

  it("reads the previous version only of the files it checks, and logs one structured event", async () => {
    const readBefore = vi.fn(reader((p) => (p === "src/pages/Home.tsx" ? HOME_BEFORE : null)));
    const log = vi.fn();
    const summary = await reportSiteDesignAdherence(
      { tenant_id: TENANT, run_id: "run-1", first_build: false, payload, files },
      { readBefore, settingOn: async () => true, log, now: () => 1000 },
    );
    expect(readBefore.mock.calls).toEqual([[["src/pages/Home.tsx"]]]);
    expect(log).toHaveBeenCalledTimes(1);
    const line = log.mock.calls[0][0];
    expect(line).toMatchObject({
      evt: "site_design_adherence",
      tenant_id: TENANT,
      site_id: "site-1",
      run_id: "run-1",
      scope: "tweak",
      redesign: false,
      outcome: "checked",
      files_checked: 2,
      warn: { raw_color: 2, font_change: 0, spacing_drift: 0, structure_drift: 1 },
      info: 0,
      total: 3,
      ms: 0,
    });
    expect(line.findings.map((f: DesignFinding) => f.evidence).sort()).toEqual(["bg-blue-500", "sections removed: CTA", "text-[#ff0000]"]);
    expect(summary).toMatchObject({ scope: "tweak", checked: 2 });
  });

  it("a first build is scoped first_build, with no structure findings", async () => {
    const log = vi.fn();
    await reportSiteDesignAdherence(
      { tenant_id: TENANT, run_id: "run-1", first_build: true, payload: { site_id: "s", idea: "a bakery" }, files },
      { readBefore: reader(() => HOME_BEFORE), settingOn: async () => true, log },
    );
    expect(log.mock.calls[0][0]).toMatchObject({ scope: "first_build", warn: { structure_drift: 0 } });
  });

  it("an unknown edit size is treated as a section change and a redesign ask is detected", async () => {
    const log = vi.fn();
    await reportSiteDesignAdherence(
      { tenant_id: TENANT, run_id: "r", first_build: false, payload: { user_request: "redesign the home page" }, files: [] },
      { readBefore: reader(() => null), settingOn: async () => true, log },
    );
    expect(log.mock.calls[0][0]).toMatchObject({ scope: "section", redesign: true, site_id: null });
  });

  it("never throws or blocks: a throwing checker logs one error event and resolves null", async () => {
    const log = vi.fn();
    const check = vi.fn(() => {
      throw new Error("boom");
    });
    await expect(
      reportSiteDesignAdherence({ tenant_id: TENANT, run_id: "r", first_build: false, payload, files }, { readBefore: reader(() => HOME_BEFORE), settingOn: async () => true, log, check }),
    ).resolves.toBeNull();
    expect(check).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatchObject({ evt: "site_design_adherence", outcome: "error", error: "boom" });
  });

  it("a failing read only skips that file, and a hung read times out with one error event", async () => {
    const log = vi.fn();
    await reportSiteDesignAdherence(
      { tenant_id: TENANT, run_id: "r", first_build: false, payload, files },
      { readBefore: async () => { throw new Error("sandbox gone"); }, settingOn: async () => true, log },
    );
    expect(log.mock.calls[0][0]).toMatchObject({ outcome: "checked", files_checked: 1, skipped: ["src/pages/Home.tsx: previous version unavailable"] });
    const log2 = vi.fn();
    await expect(
      reportSiteDesignAdherence(
        { tenant_id: TENANT, run_id: "r", first_build: false, payload, files },
        { readBefore: () => new Promise(() => undefined), settingOn: async () => true, log: log2, timeoutMs: 20 },
      ),
    ).resolves.toBeNull();
    expect(log2).toHaveBeenCalledTimes(1);
    expect(log2.mock.calls[0][0]).toMatchObject({ outcome: "error", error: "reading the previous versions timed out" });
  });

  it("a throwing logger still resolves", async () => {
    await expect(
      reportSiteDesignAdherence(
        { tenant_id: TENANT, run_id: "r", first_build: false, payload, files },
        { readBefore: reader(() => HOME_BEFORE), settingOn: async () => true, log: () => { throw new Error("stdout closed"); } },
      ),
    ).resolves.toBeNull();
  });

  it("setting off, or unreadable: no read, no check, no log", async () => {
    for (const settingOn of [async () => false, async () => { throw new Error("db down"); }]) {
      const readBefore = vi.fn();
      const check = vi.fn();
      const log = vi.fn();
      await expect(
        reportSiteDesignAdherence({ tenant_id: TENANT, run_id: "r", first_build: false, payload, files }, { readBefore, settingOn, check, log }),
      ).resolves.toBeNull();
      expect(readBefore).not.toHaveBeenCalled();
      expect(check).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    }
  });

  it("reads the per-tenant site_design_adherence_report setting by default", async () => {
    getBoolSetting.mockResolvedValueOnce(false);
    const log = vi.fn();
    await reportSiteDesignAdherence({ tenant_id: TENANT, run_id: "r", first_build: false, payload, files }, { readBefore: reader(() => null), log });
    expect(getBoolSetting).toHaveBeenCalledWith("site_design_adherence_report", TENANT);
    expect(log).not.toHaveBeenCalled();
    getBoolSetting.mockResolvedValueOnce(true);
    await reportSiteDesignAdherence({ tenant_id: TENANT, run_id: "r", first_build: false, payload, files }, { readBefore: reader(() => null), log });
    expect(log).toHaveBeenCalledTimes(1);
  });
});

describe("sandboxHeadReader", () => {
  it("reads every previous version in ONE sandbox command, with no path text in the command", async () => {
    const exec = vi.fn(async (_cmd: string) => ({ exit_code: 0, stdout: `0 B${Buffer.from("one").toString("base64")}\n1 -\n2 B\n` }));
    const paths = ["src/pages/Home.tsx", "src/pages/Missing.tsx", "src/empty.ts"];
    const got = await sandboxHeadReader(exec, "/home/user/repo")(paths);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0]![0]).not.toContain("src/pages");
    expect([...got.entries()]).toEqual([["src/pages/Home.tsx", "one"], ["src/pages/Missing.tsx", null], ["src/empty.ts", ""]]);
  });

  it("refuses an unsafe root and unsafe paths without running anything, and a failed command reads as unavailable", async () => {
    const exec = vi.fn(async () => ({ exit_code: 1, stdout: "0 Bb25l\n" }));
    expect([...(await sandboxHeadReader(exec, "/tmp; rm -rf /")(["src/a.ts"])).values()]).toEqual([null]);
    expect([...(await sandboxHeadReader(exec, "/home/user/repo")(["../etc/passwd", "/etc/passwd", "src/a\nb.ts"])).values()]).toEqual([null, null, null]);
    expect(exec).not.toHaveBeenCalled();
    expect([...(await sandboxHeadReader(exec, "/home/user/repo")(["src/a.ts"])).values()]).toEqual([null]);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("against a real git repo: paths with spaces, quotes and shell syntax read safely, a missing or oversize file is null", async () => {
    const dir = mkdtempSync(join(tmpdir(), "adherence-head-"));
    const cwd = mkdtempSync(join(tmpdir(), "adherence-cwd-"));
    try {
      const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
      git("init", "-q");
      git("config", "user.email", "t@example.test");
      git("config", "user.name", "t");
      mkdirSync(join(dir, "src"), { recursive: true });
      const files: Record<string, string> = {
        "src/a b.tsx": "export const A = 1;\n",
        "src/it's \"q\".tsx": "export const Q = 'é';\n",
        "src/$(touch pwned).tsx": "export const P = 2;\n",
        "src/big.ts": "x".repeat(MAX_ADHERENCE_FILE_BYTES + 1),
      };
      for (const [p, c] of Object.entries(files)) writeFileSync(join(dir, p), c);
      git("add", "-A");
      git("commit", "-q", "-m", "init");
      const exec = vi.fn(async (cmd: string) => {
        const stdout = execFileSync("sh", ["-c", cmd.split("/home/user/repo").join(dir)], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
        return { exit_code: 0, stdout };
      });
      const got = await sandboxHeadReader(exec, "/home/user/repo")([...Object.keys(files), "src/missing.tsx"]);
      expect(exec).toHaveBeenCalledTimes(1);
      expect(got.get("src/a b.tsx")).toBe(files["src/a b.tsx"]);
      expect(got.get("src/it's \"q\".tsx")).toBe(files["src/it's \"q\".tsx"]);
      expect(got.get("src/$(touch pwned).tsx")).toBe(files["src/$(touch pwned).tsx"]);
      expect(got.get("src/big.ts")).toBeNull();
      expect(got.get("src/missing.tsx")).toBeNull();
      expect(existsSync(join(dir, "pwned"))).toBe(false);
      expect(existsSync(join(cwd, "pwned"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("evidence never carries secrets or contact details", () => {
  it("a signed image URL loses its token, and mailto / tel / sms links keep only their scheme, in findings and in the log", async () => {
    const before = `export function SiteHeader() {\n  return <nav><a href="/about">About</a></nav>;\n}\n`;
    const after = `export function SiteHeader() {\n  return <nav><a href="/about">About</a><a href="mailto:owner@bakery.com">Email</a><a href="tel:+15551234567">Call</a><a href="sms:+15559876543">Text</a></nav>;\n}\n`;
    const page = (src: string) => `export default function About() {\n  return <main><img src="${src}" alt="" /></main>;\n}\n`;
    const signed = "https://abc.supabase.co/storage/v1/object/sign/site/hero.png?token=eyJSECRETTOKEN&expires=99";
    const files = [mod("src/components/SiteHeader.tsx", before, after), mod("src/pages/About.tsx", page("/images/old.png"), page(signed))];
    const r = run(files, { scope: "theme" });
    expect(JSON.stringify(r)).not.toMatch(/SECRETTOKEN|expires=|owner@bakery|5551234567|5559876543/);
    expect(r.findings.map((f) => f.evidence)).toEqual(
      expect.arrayContaining([
        "navigation links changed: +mailto: +tel: +sms:",
        "images changed: +https://abc.supabase.co/storage/v1/object/sign/site/hero.png -/images/old.png",
      ]),
    );
    const log = vi.fn();
    await reportSiteDesignAdherence(
      {
        tenant_id: "t",
        run_id: "r",
        first_build: false,
        payload: { edit_size: "theme" },
        files: files.map((f) => ({ path: f.path, action: f.action, content: f.after! })),
      },
      { readBefore: reader((p) => files.find((f) => f.path === p)!.before), settingOn: async () => true, log },
    );
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0].total).toBeGreaterThan(0);
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/SECRETTOKEN|expires=|owner@bakery|5551234567|5559876543/);
  });
});

describe("post-run wiring", () => {
  it("reports for every verified site run after the theme seal and before the push, and cannot fail the run", () => {
    const src = readFileSync(join(__dirname, "../../../agents/engineer/post-run.ts"), "utf-8");
    const at = src.indexOf("await reportSiteDesignAdherence(");
    expect(at).toBeGreaterThan(src.indexOf("await enforceSiteTheme("));
    expect(at).toBeLessThan(src.indexOf("3c. Ensure the inline-editor runtime"));
    const block = src.slice(src.lastIndexOf("if (isSiteRepoBuild) {", at), src.indexOf("\n  }\n", at));
    expect(block).toMatch(/first_build: isFastSinglePassPayload\(payload\)/);
    expect(block).toMatch(/const changedFiles = built\.files;/);
    expect(block).toMatch(/files: changedFiles/);
    expect(block).toMatch(/\.catch\(\(\) => null\)/);
  });
});
