import { describe, expect, it } from "vitest";
import type { DesignBrief, SitePlan } from "../design-brief";
import { checkFidelity, emptyStateLine, fidelityAddendum, journeyDeadEnd, journeyRepairSignal, mentions, planSectionIds } from "../design-fidelity";

function brief(plan: SitePlan, extra: Partial<DesignBrief> = {}): DesignBrief {
  return {
    industry: "x",
    mood: "calm",
    mode: "light",
    colors: {
      background: "#ffffff",
      foreground: "#111111",
      muted: "#f3f3f3",
      "muted-foreground": "#555555",
      primary: "#225588",
      "primary-foreground": "#ffffff",
      border: "#dddddd",
    },
    fonts: { heading: "Inter", body: "Inter" },
    plan,
    source: "model",
    ...extra,
  };
}

const DENTIST: SitePlan = {
  tone: "reassuring",
  primary_action: { label: "Book a check-up", steps: "Pick a time, enter details, confirm." },
  pages: [
    {
      path: "/",
      title: "Home",
      sections: [
        { name: "Hero", headline: "Gentle family dentistry in Millbrook" },
        { name: "Services", headline: "Check-ups, cleanings and fillings" },
        { name: "Opening hours", headline: "Open six days a week" },
        { name: "Book", headline: "Book your visit online" },
      ],
    },
    { path: "/book", title: "Book", sections: [{ name: "Calendar", headline: "Pick a time" }] },
  ],
};

const now = () => new Date("2026-10-07T00:00:00Z");

describe("brief fidelity", () => {
  it("a home page built from the plan passes: markers count even when the copy is paraphrased", () => {
    const ids = planSectionIds(DENTIST.pages[0].sections);
    expect(ids).toEqual(["hero", "services", "opening-hours", "book"]);
    const r = checkFidelity({
      brief: brief(DENTIST, { facts: ["Open six days a week"] }),
      siteName: "Millbrook Smiles",
      pages: [
        {
          path: "/",
          text: "Millbrook Smiles\nKind dental care for the whole family\nWhat we do\nWe are open Monday to Saturday — six days a week\nBook a check-up",
          sections: ids,
        },
        { path: "/book", text: "Pick a time" },
      ],
      now,
    })!;
    expect(r.gross).toBe(false);
    expect(r.items.filter((i) => !i.found)).toEqual([]);
    expect(r.checked_at).toBe("2026-10-07T00:00:00.000Z");
  });

  it("a page that kept the starter placeholder is a gross miss: no name and no planned sections", () => {
    const r = checkFidelity({
      brief: brief(DENTIST),
      siteName: "Millbrook Smiles",
      pages: [{ path: "/", text: "This site is being built. Check back soon." }],
      now,
    })!;
    expect(r.gross).toBe(true);
    expect(r.items.find((i) => i.kind === "name")?.found).toBe(false);
    const add = fidelityAddendum(r);
    expect(add).toContain('the business name "Millbrook Smiles"');
    expect(add).toContain('the "Services" section');
  });

  it("text matching is forgiving of punctuation, case and plural forms", () => {
    const home = "bella s bakery fresh sourdough loaves every saturday";
    expect(mentions(home, "Bella's Bakery", 1)).toBe(true);
    expect(mentions(home, "Fresh sourdough loaf", 0.6)).toBe(true);
    expect(mentions(home, "Wedding cakes to order", 0.6)).toBe(false);
  });

  it("a fallback brief (no model plan) checks only the name; a portfolio without a plan is not gross", () => {
    const fb: DesignBrief = { ...brief(DENTIST), plan: undefined, source: "fallback" };
    const r = checkFidelity({ brief: fb, siteName: "Ana Ruiz Photography", pages: [{ path: "/", text: "Ana Ruiz Photography\nWeddings · Portraits" }] })!;
    expect(r.items.map((i) => i.kind)).toEqual(["name", "journey"]);
    expect(r.gross).toBe(false);
    expect(fidelityAddendum(r)).toBe("");
  });

  it("an order-form site missing half its sections is gross, and only the plan's spine reaches the fix pass", () => {
    const bakery: SitePlan = {
      tone: "warm",
      primary_action: { label: "Pre-order a loaf", steps: "Choose bread, pick a Saturday, pay on pickup." },
      pages: [
        {
          path: "/",
          title: "Home",
          sections: [
            { name: "Hero", headline: "Real sourdough, baked Saturday mornings" },
            { name: "Menu", headline: "This week's loaves and cakes" },
            { name: "How it works", headline: "Order by Thursday, collect on Saturday" },
            { name: "Visit us", headline: "Find the bakery on Mill Lane" },
          ],
        },
      ],
    };
    const r = checkFidelity({
      brief: brief(bakery, { facts: ["Collect on Saturday"] }),
      siteName: "Crumb & Co",
      pages: [{ path: "/", text: "Crumb & Co\nReal sourdough, baked Saturday mornings" }],
    })!;
    expect(r.gross).toBe(true);
    const add = fidelityAddendum(r);
    expect(add).toContain('the "Menu" section');
    expect(add).toContain('the main action "Pre-order a loaf"');
    expect(add).not.toContain("Collect on Saturday");
  });

  it("a booking or class page that lists nothing until the owner adds it is a journey dead end; owner pages may be empty", () => {
    const yoga: SitePlan = {
      tone: "calm",
      primary_action: { label: "Book a class", steps: "Pick a class and sign up." },
      pages: [{ path: "/", title: "Home", sections: [{ name: "Hero", headline: "Breathe in" }] }],
    };
    const dead = checkFidelity({
      brief: brief(yoga),
      siteName: "Lotus Room",
      pages: [
        { path: "/", text: "Lotus Room\nBreathe in" },
        { path: "/classes", text: "This week\nNo classes scheduled yet." },
      ],
    })!;
    const item = journeyDeadEnd(dead)!;
    expect(item.label).toBe("Book a class works before anything is added");
    expect(item.evidence).toBe('/classes: "No classes scheduled yet."');
    expect(journeyRepairSignal(item)).toContain("before the owner adds anything");
    expect(fidelityAddendum(dead)).toContain("No classes scheduled yet.");

    const fine = checkFidelity({
      brief: brief(yoga),
      siteName: "Lotus Room",
      pages: [
        { path: "/", text: "Lotus Room\nBreathe in\nMon 7:00 Vinyasa · Tue 18:00 Yin" },
        { path: "/admin", text: "No bookings yet" },
      ],
    })!;
    expect(journeyDeadEnd(fine)).toBeNull();
    expect(emptyStateLine([{ path: "/", text: "Grand opening coming soon" }])).toBeNull();
  });

  it("no home page text means no check", () => {
    expect(checkFidelity({ brief: brief(DENTIST), siteName: "x", pages: [{ path: "/about", text: "hi" }] })).toBeNull();
    expect(fidelityAddendum(null)).toBe("");
  });
});
