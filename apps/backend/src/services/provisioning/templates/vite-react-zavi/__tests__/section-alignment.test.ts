import { describe, expect, it, vi } from "vitest";
import { createElement, type ComponentType } from "react";

vi.mock("react-router-dom", async () => {
  const { createElement: h } = await import("react");
  return {
    Link: ({ to, ...rest }: { to: string } & Record<string, unknown>) => h("a", { ...rest, href: to }),
    useLocation: () => ({ pathname: "/", hash: "", search: "" }),
  };
});
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { countGrid } from "../files/src/lib/grid";
import { Stats } from "../files/src/components/sections/Stats";
import { Features } from "../files/src/components/sections/Features";
import { Testimonials } from "../files/src/components/sections/Testimonials";
import { Pricing } from "../files/src/components/sections/Pricing";
import { Menu } from "../files/src/components/sections/Menu";

const SCREENS = ["base", "sm", "md", "lg"] as const;
type Screen = (typeof SCREENS)[number];
const ORDER: Record<Screen, number> = { base: 0, sm: 1, md: 2, lg: 3 };

function at(classes: string[], name: RegExp, screen: Screen): string | null {
  let best: { rank: number; value: string } | null = null;
  for (const c of classes) {
    const [prefix, rest] = c.includes(":") ? (c.split(":") as [string, string]) : ["base", c];
    if (!(prefix in ORDER)) continue;
    const rank = ORDER[prefix as Screen];
    if (rank > ORDER[screen]) continue;
    const m = name.exec(rest);
    if (m && (!best || rank >= best.rank)) best = { rank, value: m[1]! };
  }
  return best?.value ?? null;
}

type Row = { start: number; end: number; items: number };

function place(gridClasses: string[], itemClasses: string[][], screen: Screen): { tracks: number; rows: Row[] } {
  const tracks = Number(at(gridClasses, /^grid-cols-(\d+)$/, screen) ?? 1);
  const rows: Row[] = [];
  let row = 0;
  let col = 0;
  for (const cls of itemClasses) {
    const span = Number(at(cls, /^col-span-(\d+)$/, screen) ?? 1);
    const start = at(cls, /^col-start-(\d+|auto)$/, screen);
    if (start && start !== "auto") {
      const want = Number(start) - 1;
      if (want < col) row += 1;
      col = want;
    }
    if (col + span > tracks) {
      row += 1;
      col = start && start !== "auto" ? Number(start) - 1 : 0;
    }
    rows[row] ??= { start: col, end: col + span, items: 0 };
    rows[row]!.start = Math.min(rows[row]!.start, col);
    rows[row]!.end = Math.max(rows[row]!.end, col + span);
    rows[row]!.items += 1;
    col += span;
  }
  return { tracks, rows };
}

function misalignment(gridClasses: string[], itemClasses: string[][], screen: Screen): string[] {
  const { tracks, rows } = place(gridClasses, itemClasses, screen);
  const out: string[] = [];
  const full = rows[0]?.items ?? 0;
  rows.forEach((r, i) => {
    const left = r.start;
    const right = tracks - r.end;
    if (left !== right) out.push(`${screen} row ${i}: ${left} empty tracks left, ${right} right of ${tracks}`);
    if (i < rows.length - 1 && r.items !== full) out.push(`${screen} row ${i}: ${r.items} items, first row has ${full}`);
  });
  return out;
}

function fromHelper(count: number, max: 2 | 3 | 4) {
  const g = countGrid(count, max);
  const split = (s: string) => s.split(/\s+/).filter(Boolean);
  return { grid: split(g.grid), items: Array.from({ length: count }, (_, i) => split(g.item(i))) };
}

function dom(markup: string): Document {
  return new JSDOM(`<!doctype html><body>${markup}</body>`).window.document;
}

function html<P extends object>(C: ComponentType<P>, props: P): Document {
  return dom(renderToStaticMarkup(createElement(C as ComponentType<object>, props)));
}

function fromDom(grid: Element) {
  return { grid: [...grid.classList], items: [...grid.children].map((el) => [...el.classList]) };
}

function expectCentred(g: { grid: string[]; items: string[][] }, label: string) {
  for (const s of SCREENS) expect(misalignment(g.grid, g.items, s), `${label} at ${s}`).toEqual([]);
}

describe("countGrid", () => {
  it("every row is centred and only the last row is short, for 1..13 items at every breakpoint and max", () => {
    for (const max of [2, 3, 4] as const) {
      for (let n = 1; n <= 13; n += 1) expectCentred(fromHelper(n, max), `${n} items, max ${max}`);
    }
  });

  it("three items sit in three columns from md up, never a 4-column grid with an empty track", () => {
    for (const max of [3, 4] as const) {
      const g = fromHelper(3, max);
      for (const s of ["md", "lg"] as const) {
        const { tracks, rows } = place(g.grid, g.items, s);
        expect(rows, `max ${max} at ${s}`).toHaveLength(1);
        expect(rows[0]!.start).toBe(0);
        expect(rows[0]!.end).toBe(tracks);
      }
    }
  });

  it("widest row never exceeds max items", () => {
    for (const max of [2, 3, 4] as const) {
      for (let n = 1; n <= 13; n += 1) {
        const g = fromHelper(n, max);
        for (const s of SCREENS) expect(Math.max(...place(g.grid, g.items, s).rows.map((r) => r.items)), `${n}/${max}/${s}`).toBeLessThanOrEqual(max);
      }
    }
  });

  it("a lone item is capped and centred, not stretched across the page", () => {
    const g = countGrid(1);
    expect(g.grid.split(" ")).toEqual(expect.arrayContaining(["mx-auto", "max-w-md"]));
  });

  it("the checker catches the old fixed grids", () => {
    const oldStats = ["grid", "grid-cols-2", "md:grid-cols-4"];
    expect(misalignment(oldStats, [[], [], []], "md")).not.toEqual([]);
    expect(misalignment(oldStats, [[], [], []], "base")).not.toEqual([]);
    const oldFeatures = ["grid", "sm:grid-cols-2", "lg:grid-cols-3"];
    expect(misalignment(oldFeatures, [[], [], []], "sm")).not.toEqual([]);
    expect(misalignment(oldFeatures, [[], [], [], [], []], "lg")).not.toEqual([]);
  });
});

const LAPTOP_STATS = [
  { value: "24h", label: "Turnaround on a customised quote" },
  { value: "$0", label: "Upfront capital expense" },
  { value: "1", label: "Point of contact for your whole fleet" },
];

describe("Stats", () => {
  it("three stats fill a three-column row with no empty track, centred at every breakpoint", () => {
    const doc = html(Stats, { items: LAPTOP_STATS });
    const dl = doc.querySelector("dl")!;
    expect(dl.classList.contains("md:grid-cols-4")).toBe(false);
    expect(dl.classList.contains("md:grid-cols-3")).toBe(true);
    expectCentred(fromDom(dl), "stats");
  });

  it("numbers share a top line whatever the caption length: value pinned to the top, one fixed line height", () => {
    const doc = html(Stats, { items: LAPTOP_STATS });
    for (const cell of doc.querySelectorAll("dl > div")) {
      const cls = [...cell.classList];
      expect(cls).toContain("flex-col-reverse");
      expect(cls).toContain("justify-end");
      expect(cell.firstElementChild!.tagName).toBe("DT");
      const dd = cell.querySelector("dd")!;
      expect(dd.classList.contains("leading-none")).toBe(true);
    }
  });

  it("captions are centred, width-capped and balanced", () => {
    const doc = html(Stats, { items: LAPTOP_STATS });
    for (const dt of doc.querySelectorAll("dt")) {
      expect([...dt.classList]).toEqual(expect.arrayContaining(["mx-auto", "text-balance"]));
      expect([...dt.classList].some((c) => /^max-w-/.test(c))).toBe(true);
    }
  });

  it("phones keep stats two across, with an odd last stat centred across the row", () => {
    for (const n of [2, 3, 4, 5, 6, 7]) {
      const items = Array.from({ length: n }, (_, i) => ({ value: `${i}`, label: `label ${i}` }));
      const dl = html(Stats, { items }).querySelector("dl")!;
      expect(dl.classList.contains("grid-cols-2"), `${n} stats`).toBe(true);
      const last = dl.children[n - 1]!;
      expect(last.classList.contains("col-span-2"), `${n} stats last`).toBe(n % 2 === 1);
      expectCentred(fromDom(dl), `${n} stats`);
    }
    const one = html(Stats, { items: [{ value: "1", label: "only" }] }).querySelector("dl")!;
    expect(one.classList.contains("grid-cols-2")).toBe(false);
  });

  it("stays centred for 1, 2, 4 and 5 stats", () => {
    for (const n of [1, 2, 4, 5]) {
      const items = Array.from({ length: n }, (_, i) => ({ value: `${i}`, label: `label ${i}` }));
      expectCentred(fromDom(html(Stats, { items }).querySelector("dl")!), `${n} stats`);
    }
  });
});

const steps = [
  { title: "1. Tell us your fleet", body: "Share how many laptops and what for." },
  { title: "2. Get a quote", body: "A customised quote within a day." },
  { title: "3. Delivered and ready", body: "Set up and shipped to every desk." },
];

describe("Features grids", () => {
  it("icons: three steps fill a 3-column row from md, text centred under the centred header", () => {
    const doc = html(Features, { variant: "icons", title: "How it works", items: steps });
    const header = doc.querySelector("section h2")!.parentElement!;
    expect(header.classList.contains("text-center")).toBe(true);
    const grid = doc.querySelector("section .grid")!;
    expect(grid.classList.contains("md:grid-cols-3")).toBe(true);
    expectCentred(fromDom(grid), "icons");
    for (const item of grid.children) {
      expect(item.classList.contains("text-center")).toBe(true);
      expect(item.classList.contains("items-center")).toBe(true);
    }
  });

  it("cards and icons stay centred for 1..8 items", () => {
    for (const variant of ["cards", "icons"] as const) {
      for (let n = 1; n <= 8; n += 1) {
        const items = Array.from({ length: n }, (_, i) => ({ title: `Item ${i}`, body: "Body." }));
        expectCentred(fromDom(html(Features, { variant, title: "T", items }).querySelector("section .grid")!), `${variant} ${n}`);
      }
    }
  });

  it("cards keep equal heights: each grid cell and its card fill the row", () => {
    const doc = html(Features, { variant: "cards", title: "T", items: steps });
    for (const cell of doc.querySelector("section .grid")!.children) {
      expect(cell.classList.contains("h-full")).toBe(true);
      expect(cell.firstElementChild!.classList.contains("h-full")).toBe(true);
    }
  });
});

describe("other card rows", () => {
  it("testimonials stay centred for 1..7 reviews", () => {
    for (let n = 1; n <= 7; n += 1) {
      const items = Array.from({ length: n }, (_, i) => ({ quote: `Quote ${i}`, name: `Name ${i}` }));
      expectCentred(fromDom(html(Testimonials, { title: "Reviews", items }).querySelector("section .grid")!), `${n} reviews`);
    }
  });

  it("pricing stays centred for 1..6 plans", () => {
    for (let n = 1; n <= 6; n += 1) {
      const plans = Array.from({ length: n }, (_, i) => ({ name: `Plan ${i}`, price: `$${i}`, features: ["x"] }));
      expectCentred(fromDom(html(Pricing, { title: "Prices", plans }).querySelector("section .grid")!), `${n} plans`);
    }
  });

  it("menu centres a lone category and an odd last one", () => {
    for (let n = 1; n <= 5; n += 1) {
      const categories = Array.from({ length: n }, (_, i) => ({ name: `Cat ${i}`, items: [{ name: "x", price: "$1" }] }));
      const grid = html(Menu, { title: "Menu", categories }).querySelector("section .grid")!;
      if (n === 1) expect([...grid.classList]).toEqual(expect.arrayContaining(["mx-auto", "max-w-2xl"]));
      else expectCentred(fromDom(grid), `${n} categories`);
    }
  });
});
