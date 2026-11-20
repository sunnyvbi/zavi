import { describe, expect, it } from "vitest";
import {
  designSiteLogo,
  directedLogoType,
  heuristicLogoDesign,
  logoInitials,
  logoRenderPrompt,
  type LogoDesignSpec,
} from "../site-logo-design";

const SPEC = {
  type: "pictorial",
  subject: "a heron whose neck forms the letter S",
  concept: "Patience and precision, the heron waiting in still water",
  style: "negative-space",
  rationale: "Customers already know the bird; the mark is recognised at once.",
  avoid: ["a stock bird silhouette", "a swoosh"],
};

describe("founder direction", () => {
  it("preserves an explicit three-letter request", () => {
    expect(heuristicLogoDesign({ site_name: "Alpha Beta Company", business: "Consultancy", direction: "Use the initials ABC" }).letters).toBe("ABC");
  });
  it("does not mistake founder prose or negated letters for an initials override", () => {
    for (const direction of ["use initials of my business name", "make a monogram of my name", "monogram: use AB", "Use a monogram on a black background", "Make a monogram but keep it minimal", "MAKE A MONOGRAM ON A BLACK BACKGROUND", "Use a monogram NOT a wordmark"]) {
      expect(heuristicLogoDesign({ site_name: "Hartwell Associates", business: "Consultancy", direction }).letters).toBe("HA");
    }
    expect(heuristicLogoDesign({ site_name: "Hartwell Associates", business: "Consultancy", direction: "No initials AB, use a monogram with CD" }).letters).toBe("CD");
    expect(heuristicLogoDesign({ site_name: "Hartwell Associates", business: "Consultancy", direction: 'Use the initials "abc"' }).letters).toBe("ABC");
  });
  it("separates a positive alternative from a negated type", () => {
    expect(directedLogoType("No monogram, an abstract mark instead")).toBe("abstract");
    expect(directedLogoType("No mascot, a badge instead")).toBe("emblem");
    expect(directedLogoType("No monogram, initials or lettering")).toBeNull();
  });
});

describe("heuristic logo design (the designer is unavailable)", () => {
  it("picks a pictorial mark for a business with an ownable object and names its cliche to avoid", () => {
    const spec = heuristicLogoDesign({ site_name: "Harbor Cafe", business: "a neighbourhood cafe serving espresso and pastries" });
    expect(spec.type).toBe("pictorial");
    expect(spec.source).toBe("heuristic");
    expect(spec.avoid).toContain("a plain mug icon");
    expect(spec.subject).toMatch(/coffee cup/);
  });

  it("picks a monogram for a professional-services or long name and an abstract mark for software", () => {
    const law = heuristicLogoDesign({ site_name: "Hartwell & Associates", business: "a boutique law firm for founders" });
    expect(law).toMatchObject({ type: "monogram", letters: "HA" });
    const saas = heuristicLogoDesign({ site_name: "Flowline", business: "analytics software for logistics teams" });
    expect(saas.type).toBe("abstract");
    const long = heuristicLogoDesign({ site_name: "Northbridge Property Management", business: "property management" });
    expect(long.type).toBe("pictorial");
    const plain = heuristicLogoDesign({ site_name: "Northbridge Partners Group", business: "a general partnership" });
    expect(plain).toMatchObject({ type: "monogram", letters: "NP" });
  });

  it("picks an emblem for a heritage craft business and a mascot for a playful one", () => {
    expect(heuristicLogoDesign({ site_name: "Old Mill", business: "a small-batch brewery and taproom with a food truck" }).type).toBe("emblem");
    expect(heuristicLogoDesign({ site_name: "Pop Party", business: "kids party planning" }).type).toBe("mascot");
  });

  it("follows the founder's direction for the type and treats any other description as the subject", () => {
    expect(directedLogoType("A bold monogram of the initials")).toBe("monogram");
    expect(directedLogoType("a badge with a pine tree")).toBe("emblem");
    expect(directedLogoType("a friendly otter character")).toBe("mascot");
    expect(directedLogoType("a geometric hummingbird")).toBeNull();
    const mono = heuristicLogoDesign({ site_name: "Crumb & Co", business: "a bakery", direction: "A bold monogram of the initials" });
    expect(mono).toMatchObject({ type: "monogram", letters: "CC", source: "founder" });
    const bird = heuristicLogoDesign({ site_name: "Flight Club", business: "a running club", direction: "a geometric hummingbird" });
    expect(bird).toMatchObject({ type: "pictorial", subject: "a geometric hummingbird", source: "founder" });
  });

  it("derives initials from the first two words and ignores the ampersand", () => {
    expect(logoInitials("Hartwell & Associates")).toBe("HA");
    expect(logoInitials("Flowline")).toBe("F");
    expect(logoInitials("&")).toBe("");
  });
});

describe("designSiteLogo", () => {
  it("returns the deterministic design with no model call and no fallback reason", async () => {
    const input = { site_name: "Still Water Studio", business: "a photography studio for families", direction: "a heron" };
    const out = await designSiteLogo(input);
    expect(out.reason).toBeNull();
    expect(out.spec).toEqual(heuristicLogoDesign(input));
  });
});

describe("logoRenderPrompt", () => {
  const base: LogoDesignSpec = { ...SPEC, type: "pictorial", style: "negative-space", source: "heuristic" } as LogoDesignSpec;

  it("turns a pictorial spec into a symbol-only brief with the idea, style, avoid list, palette and hard rules", () => {
    const prompt = logoRenderPrompt(base, { site_name: "Still Water Studio", business: "a family photography studio", primary: "#123456", accent: "#abcdef" });
    expect(prompt).toContain("Still Water Studio, a family photography studio");
    expect(prompt).toContain("A pictorial mark: a heron whose neck forms the letter S.");
    expect(prompt).toContain("No text, letters or initials.");
    expect(prompt).toContain("The idea: Patience and precision");
    expect(prompt).toContain("Style: negative-space (");
    expect(prompt).toContain("Avoid: clip art, generic stock icons, a stock bird silhouette, a swoosh.");
    expect(prompt).toContain("Palette: #123456 and #abcdef.");
    expect(prompt).toMatch(/legible at 16 px/);
    expect(prompt).not.toContain("Founder direction");
  });

  it("sets the letters for a monogram, and never asks for the name as lettering", () => {
    const mono = logoRenderPrompt({ ...base, type: "monogram", letters: "HA" }, { site_name: "Hartwell & Associates" });
    expect(mono).toContain('letters "HA"');
    expect(mono).toContain("No other text.");
    expect(mono).not.toContain("No text, letters or initials");
    const fallback = logoRenderPrompt({ ...base, type: "monogram", letters: "??" }, { site_name: "Hartwell & Associates" });
    expect(fallback).toContain('letters "HA"');
    const word = logoRenderPrompt({ ...base, type: "wordmark", style: "lettering" }, { site_name: "Crumb & Co" });
    expect(word).not.toContain('"Crumb & Co"');
    expect(word).toContain("An abstract mark:");
    expect(word).toContain("one or two confident brand colours");
  });
});

describe("look-alikes, negations, names and the prompt cap", () => {
  it("does not read a negated or look-alike word as a type request", () => {
    expect(directedLogoType("no initials, just a symbol")).toBeNull();
    expect(directedLogoType("our initial idea was a fox")).toBeNull();
    expect(directedLogoType("the name in a circle")).toBeNull();
    expect(directedLogoType("not a monogram; an abstract mark")).toBe("abstract");
    expect(directedLogoType("a monogram, not a mascot")).toBe("monogram");
    expect(directedLogoType("avoid a complicated, decorative wordmark; draw a fox")).toBeNull();
    expect(directedLogoType("a cute seal balancing a ball")).toBeNull();
    expect(directedLogoType("a fox instead of a monogram")).toBeNull();
    expect(directedLogoType("no initials, use a mascot")).toBe("mascot");
    expect(directedLogoType("not a monogram, use a wordmark")).toBe("wordmark");
    expect(directedLogoType("no initials, but a badge")).toBe("emblem");
  });

  it("bounds a long founder description so the hard rendering rules always survive the cap", () => {
    const direction = "a hummingbird " + "made of flowing ribbons ".repeat(20);
    const spec = heuristicLogoDesign({ site_name: "Flight Club", business: "a running club", direction });
    expect(spec.subject.length).toBeLessThanOrEqual(140);
    const prompt = logoRenderPrompt({ ...spec, subject: direction.slice(0, 400), concept: direction.slice(0, 400) }, { site_name: "F".repeat(60), business: "b".repeat(160), primary: "#123456", accent: "#abcdef" });
    expect(prompt.length).toBeLessThanOrEqual(1000);
    expect(prompt).toMatch(/works in one colour/);
    expect(prompt).toMatch(/at most three tones/);
    expect(prompt).toMatch(/No mockup, frame, drop shadow/);
  });

  it("takes the first letter or digit of each word, splitting on punctuation joiners", () => {
    expect(logoInitials("(Ravi) Dental")).toBe("RD");
    expect(logoInitials("'Glow' Studio")).toBe("GS");
    expect(logoInitials("Fish+Chips")).toBe("FC");
    expect(logoInitials("A/B Labs")).toBe("AB");
    expect(logoInitials("日本語")).toBe("");
  });

  it("never spells a placeholder or unspellable name: monogram and wordmark fall back to a symbol", async () => {
    const asked = heuristicLogoDesign({ site_name: "this business", business: "a bakery", direction: "A bold monogram of the initials" });
    expect(asked.type).toBe("pictorial");
    const unnamed = heuristicLogoDesign({ site_name: "日本語", business: "a boutique law firm" });
    expect(unnamed.type).not.toBe("monogram");
    const designed = await designSiteLogo({ site_name: "this business", business: "a boutique law firm", direction: "A bold monogram of the initials" });
    expect(designed.spec.type).not.toBe("monogram");
    const prompt = logoRenderPrompt({ ...SPEC, type: "monogram", style: "negative-space", source: "heuristic" } as LogoDesignSpec, { site_name: "this business" });
    expect(prompt).toContain("An abstract mark:");
    expect(prompt).not.toContain('"TB"');
    expect(prompt).toContain("No text, letters or initials.");
  });

  it("keeps the vendor prompt under the cap by dropping the least important parts first", () => {
    const long: LogoDesignSpec = {
      type: "pictorial",
      subject: "x".repeat(140),
      concept: "c".repeat(220),
      style: "negative-space",
      rationale: "r".repeat(200),
      avoid: ["a".repeat(40), "b".repeat(40), "d".repeat(40), "e".repeat(40), "f".repeat(40), "g".repeat(40)],
      palette_note: "p".repeat(80),
      source: "founder",
    };
    const prompt = logoRenderPrompt(long, { site_name: "Still Water Studio", business: "y".repeat(160), primary: "#123456", accent: "#abcdef" });
    expect(prompt.length).toBeLessThanOrEqual(1000);
    expect(prompt).toContain("A pictorial mark: " + "x".repeat(140));
    expect(prompt).toContain("Palette: #123456 and #abcdef");
    expect(prompt).not.toContain("y".repeat(160));
    expect(prompt).toMatch(/legible at 16 px/);
  });
});

describe("keyword guesses match whole words", () => {
  const typeFor = (business: string) => heuristicLogoDesign({ site_name: "Northline", business, direction: "" } as never);
  it("does not read catering as cats, automation as cars, or a SaaS as a pet shop", () => {
    expect(typeFor("an event catering company").subject).not.toMatch(/animal/);
    expect(typeFor("workflow automation software for teams").subject).not.toMatch(/speed line|wheel/);
    expect(typeFor("a veterans support charity").subject).not.toMatch(/animal/);
    expect(typeFor("a dog grooming salon").subject).toMatch(/animal/);
    expect(typeFor("a car detailing service").subject).toMatch(/speed line|wheel/);
  });

  it("keeps the stems the earlier hints matched: real estate, accounting, electric, training, tourism", () => {
    expect(typeFor("a real estate agency in Leeds").type).toBe("monogram");
    expect(typeFor("an accounting firm for small businesses").type).toBe("monogram");
    expect(typeFor("a local electrical contractor").subject).toMatch(/roofline|structural/);
    expect(typeFor("strength training for runners").subject).toMatch(/strength|momentum/);
    expect(typeFor("a tourism company for mountain walks").subject).toMatch(/horizon|trail|peak/);
  });

  it("strips control characters from the founder's words before they become the subject", () => {
    const spec = heuristicLogoDesign({ site_name: "Northline", business: "a cafe", direction: "a fox\u0007 with\nstripes" } as never);
    expect(spec.subject).toBe("a fox with stripes");
  });
});

it("honours XML-escaped quoted initials in stored build directions", () => {
  expect(heuristicLogoDesign({ site_name: "Hartwell Associates", business: "Consultancy", direction: "Use the initials &quot;xyz&quot;" }).letters).toBe("XYZ");
});
