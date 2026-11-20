import { describe, expect, it } from "vitest";
import { fallbackDesignBrief, rankPresetsForIdea } from "../design-directions";
import { applyIndustryLook } from "../industry-look";

const BLUE = "#2563eb";

describe("the backup look when the design step times out", () => {
  it("gives a cake shop the soft cake-shop look, not the blue default", () => {
    const brief = fallbackDesignBrief({ idea: "Cake Website: celebration cakes, delivered or ready to collect. Mix of retail and wholesale" });
    expect(brief.look?.base).toBe("petal");
    expect(brief.colors.primary).not.toBe(BLUE);
  });

  it.each([
    "Mobile phone repair shop in Leeds",
    "Handmade leather goods",
    "Driving instructor for new learners",
    "Second hand vinyl records",
    "Wedding band for hire",
    "Tutoring for maths students",
  ])("never falls back to blue for an idea no look names: %s", (idea) => {
    const brief = fallbackDesignBrief({ idea });
    if (brief.look?.base === "clean") expect(idea).toMatch(/tutoring/i);
    else expect(brief.colors.primary).not.toBe(BLUE);
  });

  it("picks the same backup look every time for the same idea", () => {
    const idea = "Mobile phone repair shop in Leeds";
    expect(fallbackDesignBrief({ idea }).look?.base).toBe(fallbackDesignBrief({ idea }).look?.base);
  });

  it("does not hand every unmatched idea the same look", () => {
    const ideas = ["Mobile phone repair shop", "Handmade leather goods", "Driving instructor", "Second hand vinyl records", "Locksmith across the city", "Bike repair and servicing"];
    const looks = new Set(ideas.map((idea) => fallbackDesignBrief({ idea }).look?.base));
    expect(looks.size).toBeGreaterThan(1);
  });

  it("gives software its product look, never the blue default", () => {
    const brief = fallbackDesignBrief({ idea: "SaaS platform for invoicing startups" });
    expect(brief.look?.base).toBe("precise");
    expect(brief.colors.primary).not.toBe(BLUE);
  });

  it("never ranks the blue look first for an idea nothing names", () => {
    for (const idea of ["Mobile phone repair shop in Leeds", "A knitting circle that meets on Thursdays", "Second hand vinyl records", "Locksmith across the city"]) {
      expect(rankPresetsForIdea(idea)[0]).not.toBe("clean");
    }
  });

  it("gives an open-ended local service three distinct directions without making blue the recommendation", () => {
    const brief = fallbackDesignBrief({ idea: "Mobile locksmith serving homes and shops across Leeds" });
    expect(brief.colors.primary).not.toBe(BLUE);
    expect(new Set([brief.look?.base, ...(brief.look?.alternates ?? [])]).size).toBe(3);
  });

  it("keeps an explicit red-and-black direction when the model times out", () => {
    const brief = fallbackDesignBrief({ idea: "A boxing gym website with a dark black background, red accents and bold typography" });
    expect(brief.look_given).toBe("idea");
    expect(brief.direction_given).toMatch(/dark black background.*red accents.*bold typography/i);
    expect(brief.mode).toBe("dark");
    expect(brief.colors.background).toBe("#0a0a0a");
    expect(brief.colors.primary).toBe("#dc2626");
  });

  it("does not mistake a colour word in the business name for a visual instruction", () => {
    const brief = fallbackDesignBrief({ idea: "A coffee shop called Blue Bottle serving pastries and espresso" });
    expect(brief.look_given).toBeUndefined();
    expect(brief.look?.base).toBe("editorial");
  });

  it("the three choices offered after a fallback never include the base twice", () => {
    const brief = fallbackDesignBrief({ idea: "Cake Website: celebration cakes" });
    expect(brief.look?.alternates).not.toContain(brief.look?.base);
  });
});

describe("a model brief that picked generic blue for a business with its own look", () => {
  it("an orthopedic clinic moves off plain blue to the calm clinic look", () => {
    const model = {
      ...fallbackDesignBrief({ idea: "SaaS platform" }),
      industry: "Orthopedic clinic",
      source: "model" as const,
    };
    const out = applyIndustryLook(model, "Orthopedic clinic for knee and hip care");
    expect(out.look?.base).toBe("fresh");
    expect(out.colors.primary).not.toBe(BLUE);
  });
});
