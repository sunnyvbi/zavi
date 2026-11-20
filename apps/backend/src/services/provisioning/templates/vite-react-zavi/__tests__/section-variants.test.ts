import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, type ComponentType } from "react";

vi.mock("react-router-dom", async () => {
  const { createElement: h } = await import("react");
  return {
    Link: ({ to, ...rest }: { to: string } & Record<string, unknown>) => h("a", { ...rest, href: to }),
    useLocation: () => ({ pathname: "/", hash: "", search: "" }),
  };
});
vi.mock("../files/src/zavi/form", () => ({
  usePublicForm: () => ({ submit: async () => undefined, fields: null, status: "idle", error: null }),
}));
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { Hero } from "../files/src/components/sections/Hero";
import { Features } from "../files/src/components/sections/Features";
import { FEATURE_MAX_OTHERS, Gallery, featureGalleryLayout } from "../files/src/components/sections/Gallery";
import { Testimonials } from "../files/src/components/sections/Testimonials";
import { FAQ } from "../files/src/components/sections/FAQ";
import { Pricing } from "../files/src/components/sections/Pricing";
import { Menu } from "../files/src/components/sections/Menu";
import { HoursLocation } from "../files/src/components/sections/HoursLocation";
import { Stats } from "../files/src/components/sections/Stats";
import { Contact } from "../files/src/components/sections/Contact";
import { CTA } from "../files/src/components/sections/CTA";
import { SiteImage, focalPosition, type SiteImageSource } from "../files/src/components/ui/image";
import type { FeatureItem } from "../files/src/components/sections/Features";
import { PLAN_SECTION_VARIANTS } from "@/services/sites/design-brief";
import { TEMPLATE_FILES } from "../template-files.generated";

const PHOTO: SiteImageSource = {
  src: "/images/hero-1600.webp",
  srcset: "/images/hero-1600.webp 1600w, /images/hero-800.webp 800w",
  width: 1600,
  height: 900,
  alt: "A dentist talking a patient through an x-ray",
  focal: { x: 72, y: 30 },
};
const photo = (slug: string, focal?: { x: number; y: number }): SiteImageSource => ({
  src: `/images/${slug}-960.webp`,
  srcset: `/images/${slug}-960.webp 960w, /images/${slug}-480.webp 480w`,
  width: 960,
  height: 1200,
  alt: `photo of ${slug}`,
  ...(focal ? { focal } : {}),
});

function html<P extends object>(C: ComponentType<P>, props: P): string {
  return renderToStaticMarkup(createElement(C as ComponentType<object>, props));
}

function dom(markup: string): Document {
  return new JSDOM(`<!doctype html><body>${markup}</body>`).window.document;
}

const PALETTE = /\b(?:bg|text|border|from|via|to|ring|fill|stroke)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white)(?:-\d{2,3})?\b|#[0-9a-f]{3,8}\b/i;

function expectTokenOnly(markup: string) {
  const classes = [...markup.matchAll(/class="([^"]*)"/g)].map((m) => m[1]!).join(" ");
  expect(classes).not.toMatch(PALETTE);
}

function expectNoEmptyFrame(markup: string) {
  const doc = dom(markup);
  expect(doc.querySelectorAll("img")).toHaveLength(0);
  expect(doc.querySelector("[class*='aspect-']")).toBeNull();
  expect(doc.querySelector("[role='img']")).toBeNull();
  expect(doc.querySelector("svg.lucide-image")).toBeNull();
}

const base = { title: "Gentle dentistry for nervous patients", subtitle: "Same-week appointments.", actions: [{ label: "Book a visit", href: "/book" }] };
const items = [
  { title: "Check-ups", body: "Thorough and unhurried.", image: photo("checkup", { x: 30, y: 40 }) },
  { title: "Whitening", body: "In-chair or take-home.", image: photo("whitening") },
  { title: "Implants", body: "Planned with 3D scans.", image: photo("implants") },
];
const bare = items.map(({ image: _i, ...rest }) => rest);

describe("SiteImage", () => {
  it("passes srcset, sizes, width, height and the focal crop to the img", () => {
    const img = dom(html(SiteImage, { image: PHOTO, aspect: "wide" })).querySelector("img")!;
    expect(img.getAttribute("srcset")).toBe(PHOTO.srcset);
    expect(img.getAttribute("sizes")).toBe("100vw");
    expect(img.getAttribute("width")).toBe("1600");
    expect(img.getAttribute("height")).toBe("900");
    expect(img.getAttribute("style")).toMatch(/object-position:\s*72% 30%/);
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.hasAttribute("fetchpriority")).toBe(false);
  });

  it("eager-loads a priority image with high fetch priority", () => {
    const img = dom(html(SiteImage, { image: PHOTO, priority: true })).querySelector("img")!;
    expect(img.getAttribute("loading")).toBe("eager");
    expect(img.getAttribute("fetchpriority")).toBe("high");
  });

  it("without a usable src it is the decorative brand panel (#3912): no img, no icon, marked for the publish check", () => {
    for (const image of [null, { src: "  ", alt: "x" }]) {
      const doc = dom(html(SiteImage, { image }));
      expect(doc.querySelectorAll("img")).toHaveLength(0);
      expect(doc.querySelector("[data-zavi-image='none'][aria-hidden='true']")).not.toBeNull();
      expect(doc.querySelector("svg.lucide-image")).toBeNull();
    }
  });

  it("clamps focal points and ignores broken ones", () => {
    expect(focalPosition({ x: 140, y: -12.6 })).toBe("100% 0%");
    expect(focalPosition({ x: Number.NaN, y: 3 })).toBeUndefined();
    expect(focalPosition(undefined)).toBeUndefined();
  });

  it("an explicit sizes wins and a plain {src, alt} image gets no srcset or sizes", () => {
    const img = dom(html(SiteImage, { image: { src: "/images/a.webp", alt: "a" } })).querySelector("img")!;
    expect(img.hasAttribute("srcset")).toBe(false);
    expect(img.hasAttribute("sizes")).toBe(false);
    expect(img.hasAttribute("style")).toBe(false);
  });
});

describe("Hero variants", () => {
  for (const variant of ["split", "image", "editorial", "centered"] as const) {
    it(`${variant} with a photo: one eager hero img carrying srcset, sizes, size and focal`, () => {
      const markup = html(Hero, { ...base, variant, image: PHOTO });
      const imgs = dom(markup).querySelectorAll("img");
      expect(imgs).toHaveLength(1);
      const img = imgs[0]!;
      expect(img.getAttribute("loading")).toBe("eager");
      expect(img.getAttribute("fetchpriority")).toBe("high");
      expect(img.getAttribute("srcset")).toBe(PHOTO.srcset);
      expect(img.getAttribute("sizes")).toBeTruthy();
      expect(img.getAttribute("width")).toBe("1600");
      expect(img.getAttribute("style")).toMatch(/72% 30%/);
      expectTokenOnly(markup);
    });

    it(`${variant} without a photo: no frame, no placeholder, one h1`, () => {
      const markup = html(Hero, { ...base, variant, image: null });
      expectNoEmptyFrame(markup);
      expect(dom(markup).querySelectorAll("h1")).toHaveLength(1);
      expectTokenOnly(markup);
    });
  }

  it("split falls back to the centred layout without a photo; image keeps its overlay on the brand gradient", () => {
    const split = dom(html(Hero, { ...base, variant: "split", image: { src: "", alt: "" } }));
    expect(split.querySelector(".text-center h1")).not.toBeNull();
    expect(split.querySelector("[class*='lg:grid-cols-2']")).toBeNull();
    const image = dom(html(Hero, { ...base, variant: "image", image: { src: "", alt: "" } }));
    expect(image.querySelector(".surface-overlay [data-zavi-image='none']")).not.toBeNull();
    expect(image.querySelectorAll("img")).toHaveLength(0);
  });

  it("editorial without a photo keeps its own left-aligned, single-column type layout", () => {
    const doc = dom(html(Hero, { ...base, variant: "editorial", eyebrow: "Family dental", image: undefined }));
    expect(doc.querySelector(".text-center")).toBeNull();
    expect(doc.querySelector("[class*='lg:grid-cols-12']")).toBeNull();
    expect(doc.body.textContent).toContain("Family dental");
  });

  it("editorial with a photo is asymmetric: 7 columns of type, an offset 5-column photo", () => {
    const doc = dom(html(Hero, { ...base, variant: "editorial", image: PHOTO }));
    expect(doc.querySelector("[class*='lg:col-span-7'] h1")).not.toBeNull();
    expect(doc.querySelector("[class*='lg:col-span-5'][class*='lg:mt-'] img")).not.toBeNull();
  });
});

describe("Features variants", () => {
  it("split: list beside one photo, numbered, below-the-fold photo lazy", () => {
    const markup = html(Features, { variant: "split", title: "Treatments", items: bare, image: photo("room", { x: 40, y: 20 }) });
    const doc = dom(markup);
    expect(doc.querySelectorAll("ol > li")).toHaveLength(3);
    const img = doc.querySelector("img")!;
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.hasAttribute("fetchpriority")).toBe(false);
    expect(img.getAttribute("style")).toMatch(/40% 20%/);
    expect(doc.querySelector("h2")?.textContent).toBe("Treatments");
    expectTokenOnly(markup);
  });

  it("split without a photo keeps the list and the header and shows no frame", () => {
    const markup = html(Features, { variant: "split", title: "Treatments", items: bare });
    expectNoEmptyFrame(markup);
    expect(dom(markup).querySelectorAll("ol > li")).toHaveLength(3);
  });

  it("alternating with photos: rows with lazy, sized images and focal crops", () => {
    const doc = dom(html(Features, { variant: "alternating", title: "What we do", items }));
    const imgs = [...doc.querySelectorAll("img")];
    expect(imgs).toHaveLength(3);
    expect(imgs.every((i) => i.getAttribute("loading") === "lazy" && i.getAttribute("srcset") && i.getAttribute("width") === "960")).toBe(true);
    expect(imgs[0]!.getAttribute("style")).toMatch(/30% 40%/);
    expect(doc.querySelectorAll("[class*='md:col-span-7']")).toHaveLength(3);
  });

  it("alternating with no photos keeps its rows, each on a decorative brand panel (#3912), never an image icon", () => {
    const doc = dom(html(Features, { variant: "alternating", title: "What we do", items: bare }));
    expect(doc.querySelectorAll("img")).toHaveLength(0);
    expect(doc.querySelectorAll("[data-zavi-image='none']")).toHaveLength(3);
    expect(doc.querySelector("svg.lucide-image")).toBeNull();
    expect(doc.querySelectorAll("h3")).toHaveLength(3);
  });

  it("alternating with one missing photo puts the brand panel in that row only", () => {
    const mixed = [items[0]!, bare[1]!, items[2]!];
    const doc = dom(html(Features, { variant: "alternating", title: "What we do", items: mixed }));
    expect(doc.querySelectorAll("img")).toHaveLength(2);
    expect(doc.querySelectorAll("[data-zavi-image='none']")).toHaveLength(1);
  });

  it("cards never render an empty image frame", () => {
    const markup = html(Features, { variant: "cards", title: "What we do", items: bare });
    expectNoEmptyFrame(markup);
  });
});

describe("Gallery feature", () => {
  const shots = ["a", "b", "c", "d", "e"].map((s) => photo(s));

  it("leads with one large photo, then a grid; every img sized and lazy", () => {
    const markup = html(Gallery, { variant: "feature", title: "Selected work", images: shots });
    const doc = dom(markup);
    const imgs = [...doc.querySelectorAll("img")];
    expect(imgs).toHaveLength(5);
    expect(imgs[0]!.getAttribute("sizes")).toBe("(min-width: 768px) 50vw, 100vw");
    expect(imgs.slice(1).every((i) => i.getAttribute("sizes") === "(min-width: 768px) 25vw, 50vw")).toBe(true);
    expect(imgs.every((i) => i.getAttribute("loading") === "lazy")).toBe(true);
    expect(doc.querySelector("[class*='md:row-span-2'] img")).toBe(imgs[0]);
    expectTokenOnly(markup);
  });

  it("drops images without a src and renders nothing when none are left", () => {
    expect(dom(html(Gallery, { variant: "feature", images: [{ src: "", alt: "" }, shots[0]!] })).querySelectorAll("img")).toHaveLength(1);
    expect(html(Gallery, { variant: "feature", images: [{ src: "", alt: "" }] })).toBe("");
  });

  it("a lone lead photo spans the row without an empty grid beside it", () => {
    const doc = dom(html(Gallery, { variant: "feature", images: [shots[0]!] }));
    expect(doc.querySelector("section .grid")!.className).toMatch(/(^| )grid-cols-1( |$)/);
    expect(doc.querySelector("section .grid")!.className).not.toMatch(/md:grid-cols-[2-9]/);
    expect(doc.querySelector("[class*='row-span-2']")).toBeNull();
  });
});

describe("CTA split", () => {
  it("with a photo: copy beside a sized photo", () => {
    const doc = dom(html(CTA, { variant: "split", title: "Book today", image: photo("chair") }));
    expect(doc.querySelectorAll("img")).toHaveLength(1);
  });

  it("without a photo falls back to the centred banner", () => {
    const markup = html(CTA, { variant: "split", title: "Book today", image: null });
    expectNoEmptyFrame(markup);
    expect(dom(markup).querySelector(".text-center h2")).not.toBeNull();
  });
});

describe("a photo that fails to load", () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  async function mount(element: ReturnType<typeof createElement>) {
    const win = new JSDOM("<!doctype html><body><div id=root></div></body>", { pretendToBeVisual: true }).window;
    const g = globalThis as Record<string, unknown>;
    const saved = { window: g.window, document: g.document, navigator: g.navigator, act: g.IS_REACT_ACT_ENVIRONMENT };
    Object.assign(g, { window: win, document: win.document, IS_REACT_ACT_ENVIRONMENT: true });
    Object.defineProperty(g, "navigator", { value: win.navigator, configurable: true, writable: true });
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react");
    const root = createRoot(win.document.getElementById("root")!);
    await act(async () => root.render(element));
    cleanup = () => {
      root.unmount();
      Object.assign(g, { window: saved.window, document: saved.document, IS_REACT_ACT_ENVIRONMENT: saved.act });
      Object.defineProperty(g, "navigator", { value: saved.navigator, configurable: true, writable: true });
    };
    const fail = async (img: Element) => act(async () => void img.dispatchEvent(new win.Event("error")));
    return { doc: win.document, fail };
  }

  it("a split hero keeps its layout and marks the failed photo for the publish check", async () => {
    const { doc, fail } = await mount(createElement(Hero, { ...base, variant: "split", image: PHOTO }));
    expect(doc.querySelector("[class*='lg:grid-cols-2'] img")).not.toBeNull();
    await fail(doc.querySelector("img")!);
    expect(doc.querySelectorAll("img")).toHaveLength(0);
    expect(doc.querySelector("[class*='lg:grid-cols-2'] [data-zavi-image='error']")).not.toBeNull();
  });

  it("a failed gallery tile keeps its cell, marked, and the grid has no holes", async () => {
    const { doc, fail } = await mount(createElement(Gallery, { variant: "feature", images: ["a", "b", "c"].map((s) => photo(s)) }));
    const before = doc.querySelectorAll("section .grid > *").length;
    await fail(doc.querySelectorAll("img")[1]!);
    expect(doc.querySelectorAll("img")).toHaveLength(2);
    expect(doc.querySelectorAll("[data-zavi-image='error']")).toHaveLength(1);
    expect(doc.querySelectorAll("section .grid > *").length).toBe(before);
    for (const bp of BREAKPOINTS) expect(holes(gridFromDom(doc, bp)), bp).toEqual([]);
  });

  it("a failed feature card photo is marked in place, never an image icon", async () => {
    const Icon = ((props: Record<string, unknown>) => createElement("svg", { ...props, "data-testid": "card-icon" })) as unknown as NonNullable<FeatureItem["icon"]>;
    const cards = [{ title: "Check-ups", body: "Thorough.", icon: Icon, image: photo("checkup") }, { title: "Whitening", body: "Bright.", icon: Icon }];
    const { doc, fail } = await mount(createElement(Features, { variant: "cards", title: "What we do", items: cards }));
    await fail(doc.querySelector("img")!);
    expect(doc.querySelectorAll("img")).toHaveLength(0);
    expect(doc.querySelectorAll("[data-zavi-image='error']")).toHaveLength(1);
    expect(doc.querySelector("svg.lucide-image")).toBeNull();
  });
});

describe("the plan's variant list matches the section library", () => {
  it("every planned variant exists in its component's variant union, and every union member is plannable", () => {
    for (const [component, variants] of Object.entries(PLAN_SECTION_VARIANTS)) {
      const src = TEMPLATE_FILES[`src/components/sections/${component}.tsx`];
      expect(src, component).toBeTypeOf("string");
      const union = /variant\?:\s*((?:"[a-z]+"\s*\|?\s*)+);/.exec(src!)?.[1];
      const declared = union ? [...union.matchAll(/"([a-z]+)"/g)].map((m) => m[1]) : [];
      expect([...declared].sort(), component).toEqual([...variants].sort());
    }
  });
});

const BREAKPOINTS = ["base", "md"] as const;
type Breakpoint = (typeof BREAKPOINTS)[number];
type GridItem = { cols: number; rows: number; intrinsic: boolean };
type Grid = { cols: number; items: GridItem[] };

function classAt(classes: string[], name: RegExp, bp: Breakpoint): number | null {
  const base = classes.map((c) => name.exec(c)?.[1]).find(Boolean) ?? null;
  const md = classes.filter((c) => c.startsWith("md:")).map((c) => name.exec(c.slice(3))?.[1]).find(Boolean) ?? null;
  const v = bp === "md" ? md ?? base : base;
  return v === null ? null : Number(v);
}

function gridItem(classes: string[], frame: string[], bp: Breakpoint): GridItem {
  return {
    cols: classAt(classes, /^col-span-(\d+)$/, bp) ?? 1,
    rows: classAt(classes, /^row-span-(\d+)$/, bp) ?? 1,
    intrinsic: !(bp === "md" && frame.includes("md:aspect-auto")) && frame.some((c) => /^aspect-/.test(c)),
  };
}

function gridFromLayout(n: number, bp: Breakpoint): Grid {
  const layout = featureGalleryLayout(n);
  const split = (s?: string) => (s ?? "").split(/\s+/).filter(Boolean);
  const ASPECT_CLASS = { square: "aspect-square", portrait: "aspect-[4/5]", landscape: "aspect-[4/3]", wide: "aspect-[16/9]", fill: "" } as const;
  const cell = (c: (typeof layout)["lead"]) => gridItem(split(c.className), [ASPECT_CLASS[c.aspect], ...split(c.frameClassName)].filter(Boolean), bp);
  return { cols: classAt(split(layout.grid), /^grid-cols-(\d+)$/, bp) ?? 1, items: [cell(layout.lead), ...layout.others.map(cell)] };
}

function gridFromDom(doc: Document, bp: Breakpoint): Grid {
  const grid = doc.querySelector("section .grid")!;
  const items = [...grid.children].map((el) => gridItem([...el.classList], [...(el.firstElementChild?.classList ?? [])], bp));
  return { cols: classAt([...grid.classList], /^grid-cols-(\d+)$/, bp) ?? 1, items };
}

function holes({ cols, items }: Grid): string[] {
  const taken: boolean[][] = [];
  const free = (r: number, c: number) => !taken[r]?.[c];
  const problems: string[] = [];
  const rowOf: GridItem[][] = [];
  let cr = 0;
  let cc = 0;
  for (const it of items) {
    if (it.cols > cols) problems.push(`span ${it.cols} > ${cols} columns`);
    const w = Math.min(it.cols, cols);
    let placed = false;
    for (let r = cr; !placed; r += 1) {
      for (let c = r === cr ? cc : 0; c + w <= cols && !placed; c += 1) {
        let fits = true;
        for (let dr = 0; dr < it.rows; dr += 1) for (let dc = 0; dc < w; dc += 1) if (!free(r + dr, c + dc)) fits = false;
        if (!fits) continue;
        for (let dr = 0; dr < it.rows; dr += 1) {
          taken[r + dr] ??= [];
          rowOf[r + dr] ??= [];
          rowOf[r + dr]!.push(it);
          for (let dc = 0; dc < w; dc += 1) taken[r + dr]![c + dc] = true;
        }
        cr = r;
        cc = c + w;
        placed = true;
      }
    }
  }
  taken.forEach((row, r) => {
    for (let c = 0; c < cols; c += 1) if (!row[c]) problems.push(`empty cell r${r} c${c}`);
    if (!rowOf[r]!.some((it) => it.rows === 1 && it.intrinsic)) problems.push(`row ${r} has no item that gives it a height`);
  });
  return problems;
}

describe("Gallery feature layout never leaves an empty cell", () => {
  it("the pure layout fills every cell at both breakpoints for 0..12 other photos", () => {
    for (let n = 0; n <= 12; n += 1) {
      for (const bp of BREAKPOINTS) {
        const g = gridFromLayout(n, bp);
        expect(g.items).toHaveLength(1 + Math.min(n, FEATURE_MAX_OTHERS));
        expect(holes(g), `${n} others at ${bp}`).toEqual([]);
      }
    }
  });

  it("the rendered gallery takes its classes from the layout and has no holes, for 1..13 photos", () => {
    for (let k = 1; k <= 13; k += 1) {
      const doc = dom(html(Gallery, { variant: "feature", images: Array.from({ length: k }, (_, i) => photo(`g${i}`)) }));
      const layout = featureGalleryLayout(k - 1);
      const grid = doc.querySelector("section .grid")!;
      expect(grid.className).toBe(layout.grid);
      const kids = [...grid.children];
      expect(kids).toHaveLength(1 + Math.min(k - 1, FEATURE_MAX_OTHERS));
      [layout.lead, ...layout.others].forEach((cell, i) => {
        for (const c of (cell.className ?? "").split(" ").filter(Boolean)) expect(kids[i]!.classList.contains(c), `${k}:${i}:${c}`).toBe(true);
      });
      for (const bp of BREAKPOINTS) expect(holes(gridFromDom(doc, bp)), `${k} photos at ${bp}`).toEqual([]);
    }
  });

  it("the cell checker itself catches the old layout's holes", () => {
    const oldLead = { cols: 2, rows: 2, intrinsic: false };
    const sq = { cols: 1, rows: 1, intrinsic: true };
    expect(holes({ cols: 4, items: [oldLead, sq] })).not.toEqual([]);
    expect(holes({ cols: 2, items: [{ cols: 2, rows: 1, intrinsic: true }, sq, sq, sq] })).not.toEqual([]);
  });
});

describe("every library section forwards data-zavi-section to its root <section>", () => {
  const cases: Array<[string, ComponentType<never>, Record<string, unknown>]> = [
    ...(["centered", "split", "image", "editorial", "minimal"] as const).map((variant) => [`Hero ${variant}`, Hero, { ...base, variant, image: PHOTO }] as [string, ComponentType<never>, Record<string, unknown>]),
    ...(["cards", "icons", "alternating", "split"] as const).map((variant) => [`Features ${variant}`, Features, { variant, title: "T", items, image: photo("room") }] as [string, ComponentType<never>, Record<string, unknown>]),
    ...(["cards", "quote"] as const).map((variant) => [`Testimonials ${variant}`, Testimonials, { variant, items: [{ quote: "Kind and calm.", name: "Sam" }] }] as [string, ComponentType<never>, Record<string, unknown>]),
    ...(["grid", "masonry", "feature"] as const).map((variant) => [`Gallery ${variant}`, Gallery, { variant, images: [photo("a"), photo("b")] }] as [string, ComponentType<never>, Record<string, unknown>]),
    ...(["banner", "split"] as const).map((variant) => [`CTA ${variant}`, CTA, { variant, title: "Book", image: photo("chair") }] as [string, ComponentType<never>, Record<string, unknown>]),
    ["FAQ", FAQ, { items: [{ question: "Q?", answer: "A." }] }],
    ["Pricing", Pricing, { title: "Prices", plans: [{ name: "Check-up", price: "$45", features: ["Exam"] }] }],
    ["Menu", Menu, { title: "Menu", categories: [{ name: "Coffee", items: [{ name: "Flat white", price: "$4" }] }] }],
    ["HoursLocation", HoursLocation, { hours: [{ days: "Mon-Fri", hours: "9-5" }], address: "1 High St" }],
    ["Stats", Stats, { items: [{ value: "20+", label: "years" }] }],
    ["Contact", Contact, { email: "hi@example.com" }],
  ];

  it.each(cases)("%s", (_name, C, props) => {
    const doc = dom(html(C as ComponentType<object>, { ...props, "data-zavi-section": "plan-id" }));
    const marked = doc.querySelectorAll("[data-zavi-section]");
    expect(marked).toHaveLength(1);
    expect(marked[0]!.tagName).toBe("SECTION");
    expect(marked[0]!.getAttribute("data-zavi-section")).toBe("plan-id");
    expect(doc.body.firstElementChild).toBe(marked[0]);
  });

  it("covers every plannable component", () => {
    const covered = new Set(cases.map(([name]) => name.split(" ")[0]));
    expect([...covered].sort()).toEqual(Object.keys(PLAN_SECTION_VARIANTS).sort());
  });

  it("adds no attribute when the plan gives no id", () => {
    expect(html(Hero, { ...base, variant: "centered" })).not.toContain("data-zavi-section");
  });
});
