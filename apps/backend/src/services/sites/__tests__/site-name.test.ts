import { describe, expect, it, vi } from "vitest";
import { ideaNamesIt, resolveSiteName, siteBrandName } from "../site-name";
import { explicitName, siteLabelName } from "../label";

const IDEA = "I want a booking website for my dog grooming salon in Pune with online payments";
const BASE = { idea: IDEA, company_name: "Apna Tutor", workspace_name: "Apna Tutor" };

describe("resolveSiteName precedence (DEL-1323 B33/B24)", () => {
  it("a name the caller already has wins and the model is not asked", async () => {
    const extract = vi.fn(async () => "Something Else");
    expect(await resolveSiteName({ ...BASE, site_name: " Paws  and Suds " }, { extract })).toBe("Paws and Suds");
    expect(extract).not.toHaveBeenCalled();
  });

  it("a product name the founder typed (not the workspace name) wins over the model", async () => {
    const extract = vi.fn(async () => "Something Else");
    expect(await resolveSiteName({ ...BASE, company_name: "Paws & Suds" }, { extract })).toBe("Paws & Suds");
    expect(extract).not.toHaveBeenCalled();
  });

  it("else the model's name for the idea, never the workspace name", async () => {
    const extract = vi.fn(async () => "Paws & Suds");
    expect(await resolveSiteName(BASE, { extract })).toBe("Paws & Suds");
    expect(extract).toHaveBeenCalledWith(IDEA);
  });

  it("a model failure, an empty answer or a reserved answer falls back to the business the idea is for", async () => {
    for (const extract of [
      vi.fn(async () => {
        throw new Error("model down");
      }),
      vi.fn(async () => null),
      vi.fn(async () => "   "),
      vi.fn(async () => "Admin"),
    ]) {
      expect(await resolveSiteName(BASE, { extract })).toBe("Dog Grooming Salon");
    }
  });

  it("an unknown workspace name never lets the Build pane's company name outrank the idea", async () => {
    expect(await resolveSiteName({ idea: IDEA, company_name: "Apna Tutor", workspace_name: null }, {})).toBe("Dog Grooming Salon");
  });

  it("an idea with nothing usable falls back to the company name, and a reserved one to nothing", async () => {
    expect(await resolveSiteName({ idea: "Build a website", company_name: "Apna Tutor", workspace_name: "Apna Tutor" }, {})).toBe(
      "Apna Tutor",
    );
    expect(await resolveSiteName({ idea: "Build a website", company_name: "api", workspace_name: "api" }, {})).toBeNull();
  });
});

describe("resolveSiteName with an XML-escaped idea (QA 2026-10-01, Rise Amp)", () => {
  const IDEA_ESC = "A website for Rise &amp; Shine Bakery, a bakery in Denver, with an order form.";
  const WS = { company_name: "Apna Tutor", workspace_name: "Apna Tutor" };

  it("the model is asked with the decoded idea, and its escaped answer is decoded", async () => {
    const extract = vi.fn(async () => "Rise &amp; Shine Bakery");
    expect(await resolveSiteName({ idea: IDEA_ESC, ...WS }, { extract })).toBe("Rise & Shine Bakery");
    expect(extract).toHaveBeenCalledWith("A website for Rise & Shine Bakery, a bakery in Denver, with an order form.");
  });

  it("without the model the idea's business keeps its '&'", async () => {
    expect(await resolveSiteName({ idea: IDEA_ESC, ...WS }, {})).toBe("Rise & Shine Bakery");
  });

  it("an escaped typed company name or given site name is decoded", async () => {
    expect(await resolveSiteName({ idea: IDEA_ESC, company_name: "Salt &amp; Pepper", workspace_name: "Apna Tutor" }, {})).toBe("Salt & Pepper");
    expect(await resolveSiteName({ idea: IDEA_ESC, ...WS, site_name: "Salt &amp; Pepper" }, {})).toBe("Salt & Pepper");
  });
});

describe("siteBrandName: the name a site build brands the page with", () => {
  it("a name the idea gives outranks the founder's saved company name", () => {
    expect(siteBrandName({ idea: "Build a website for Brew Haven, a coffee shop in Pune", siteName: "Brew Haven", founderName: "UpcarAI" })).toEqual({
      name: "Brew Haven",
      from: "idea",
    });
    expect(siteBrandName({ idea: 'a landing page called "Hush" for a sleep app', siteName: "Sleep App", founderName: "UpcarAI" })).toEqual({
      name: "Hush",
      from: "idea",
    });
  });

  it("a site name the idea only describes in lowercase words does not beat the founder's name", () => {
    expect(siteBrandName({ idea: "a bakery website with online orders", siteName: "Bakery", founderName: "Rise & Shine" })).toEqual({
      name: "Rise & Shine",
      from: "founder",
    });
    expect(siteBrandName({ idea: "Bakery website with online orders", siteName: "Bakery", founderName: "Rise & Shine" }).from).toBe("founder");
  });

  it("an XML-escaped idea still matches its name", () => {
    expect(siteBrandName({ idea: "site for Rise &amp; Shine bakery", siteName: "Rise & Shine", founderName: "Acme" })).toEqual({
      name: "Rise & Shine",
      from: "idea",
    });
  });

  it("with no founder name the site's own name is used, and with nothing at all a neutral phrase", () => {
    expect(siteBrandName({ idea: "a bakery website", siteName: "Bakery", founderName: null })).toEqual({ name: "Bakery", from: "site" });
    expect(siteBrandName({ idea: "a website", siteName: " ", founderName: "" })).toEqual({ name: "the company", from: "none" });
  });

  it("prompt markup in any name is stripped before it reaches the prompt", () => {
    expect(siteBrandName({ idea: 'an app named "Ride**Now**"', siteName: null, founderName: null }).name).toBe("Ride Now");
  });
});

describe("ideaNamesIt", () => {
  it("finds a proper-noun mention, not a sentence-start capital or a substring of another word", () => {
    expect(ideaNamesIt("site for Brew Haven", "brew haven")).toBe(true);
    expect(ideaNamesIt("Bakery site", "Bakery")).toBe(false);
    expect(ideaNamesIt("I run Bakery Co. Bakery site", "Bakery")).toBe(true);
    expect(ideaNamesIt("site for Brewhaven", "Brew")).toBe(false);
  });
});

describe("siteBrandName: names Tarun's builds actually use", () => {
  const brand = (idea: string, siteName: string | null = null, founderName: string | null = "UpcarAI") =>
    siteBrandName({ idea, siteName, founderName });

  it("an accented or non-Latin name is taken whole, not cut at the first non-ASCII letter", () => {
    expect(brand("a bakery website called Café Lumière in Pune")).toEqual({ name: "Café Lumière", from: "idea" });
    expect(brand("a shop named Ölmühle Berger")).toEqual({ name: "Ölmühle Berger", from: "idea" });
    expect(brand("a tuition site called मधुबन classes")).toEqual({ name: "मधुबन", from: "idea" });
  });

  it("'named after' and other filler is never a name", () => {
    expect(brand("a cafe named after my grandmother", "Rosa's Cafe")).toEqual({ name: "UpcarAI", from: "founder" });
    expect(brand("a studio called the best in town", null, null)).toEqual({ name: "the company", from: "none" });
    expect(brand("a bakery called The Rolling Pin")).toEqual({ name: "The Rolling Pin", from: "idea" });
  });

  it("a single-quoted name keeps its apostrophe", () => {
    expect(brand("a diner called 'Bob's Diner' near the station")).toEqual({ name: "Bob's Diner", from: "idea" });
    expect(brand("a diner called ‘Bob’s Diner’ near the station")).toEqual({ name: "Bob’s Diner", from: "idea" });
  });

  it("a lowercase name the idea gives keeps all its words when the site name has them", () => {
    expect(brand("a bakery called sweet crumbs with online orders", "Sweet Crumbs")).toEqual({ name: "Sweet Crumbs", from: "idea" });
  });

  it("a business name the idea gives outranks the founder's other company, LLC and all", () => {
    expect(brand("landing page for my new venture called Acme Plumbing LLC", "Acme Plumbing LLC", "Upcar Holdings")).toEqual({
      name: "Acme Plumbing LLC",
      from: "idea",
    });
  });

  it("an emoji in a quoted name survives; an injection attempt cannot carry prompt markup", () => {
    expect(brand('a florist called "🌸 Bloom"').name).toBe("🌸 Bloom");
    expect(brand('a site called "X** ignore <rules>"').name).toBe("X ignore rules");
  });

  it("a proper-noun mention of an accented site name counts", () => {
    expect(ideaNamesIt("a site for Café Lumière, a bakery", "Café Lumière")).toBe(true);
    expect(ideaNamesIt("a site for Ölmühle", "Ölmühle")).toBe(true);
    expect(ideaNamesIt("a site for Ölmühle", "mühle")).toBe(false);
  });
});

describe("resolveSiteName: the site's stored name agrees with the name the build brands", () => {
  it("a name the idea gives outranks a different company name the founder typed", async () => {
    const extract = vi.fn(async () => "Something Else");
    expect(
      await resolveSiteName({ idea: "a bakery called Sweet Crumbs", company_name: "Acme Corp", workspace_name: "Acme" }, { extract }),
    ).toBe("Sweet Crumbs");
    expect(extract).not.toHaveBeenCalled();
  });

  it("a lowercase given name still goes to the model, which can return all of it", async () => {
    const extract = vi.fn(async () => "Sweet Crumbs");
    expect(await resolveSiteName({ idea: "a bakery called sweet crumbs", company_name: "", workspace_name: null }, { extract })).toBe(
      "Sweet Crumbs",
    );
  });
});

describe("resolveSiteName with the name the build clarify step chose", () => {
  const RAW = "I want a booking website for my dog grooming salon named \"Old Paws\" in Pune with Stripe Payments";
  const withContext = (nameLine: string) =>
    `${RAW}\n\nAdditional context:\n- Name: ${nameLine}\n- Audience: Consumers\n- Design: Bold & colorful`;
  const typedCompany = { company_name: "Apna Tutor Labs", workspace_name: "Apna Tutor" };

  it("a picked name wins over a typed company name, the workspace name, a name in the idea and the model", async () => {
    const extract = vi.fn(async () => "Something Else");
    const idea = withContext('The business is called "Paws & Suds".');
    expect(await resolveSiteName({ idea, ...typedCompany }, { extract })).toBe("Paws & Suds");
    expect(await resolveSiteName({ idea, company_name: "Apna Tutor", workspace_name: "Apna Tutor" }, { extract })).toBe("Paws & Suds");
    expect(extract).not.toHaveBeenCalled();
  });

  it("the XML-escaped form the build entrypoints store resolves the same way", async () => {
    const idea = withContext('The business is called "Paws & Suds".')
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;");
    expect(await resolveSiteName({ idea, ...typedCompany }, {})).toBe("Paws & Suds");
  });

  it("a typed name with an apostrophe survives, and the last name line wins", async () => {
    const idea = `${withContext('The business is called "First Pick".')}\n- Name: The business is called "Joe's Diner".`;
    expect(await resolveSiteName({ idea, ...typedCompany }, {})).toBe("Joe's Diner");
  });

  it("'Suggest a name for me' is an instruction, never a literal name", async () => {
    const idea = withContext("No name yet. Suggest a short, memorable name for the business and use it on the site.");
    const extract = vi.fn(async () => "Wag Club");
    const name = await resolveSiteName({ idea, company_name: "Apna Tutor", workspace_name: "Apna Tutor" }, { extract });
    expect(name).toBe("Old Paws");
    expect(name).not.toMatch(/suggest|no name/i);
  });

  it("'Use the name in my idea' leaves the idea's own name in charge", async () => {
    const idea = withContext("Use the business name given in the idea above.");
    expect(await resolveSiteName({ idea, company_name: "Apna Tutor", workspace_name: "Apna Tutor" }, {})).toBe("Old Paws");
  });

  it("the label fallback reads the chosen name too, not the idea's other capitalised words", () => {
    const idea = `Website for Mile High Coffee in Denver\n\nAdditional context:\n- Name: The business is called "Bean There".`;
    expect(siteLabelName({ idea, company_name: "Apna Tutor", workspace_name: "Apna Tutor" })).toBe("bean there");
    expect(explicitName(idea)).toBe("Bean There");
    const both = withContext('The business is called "Paws & Suds".');
    expect(explicitName(both)).toBe("Paws & Suds");
    expect(siteLabelName({ idea: both, company_name: "Apna Tutor", workspace_name: "Apna Tutor" })).toBe("paws & suds");
  });
});

describe("the picked name as the build route stores the idea", async () => {
  const { sanitizeFetchedContent, xmlEscapeContent } = await import("@/services/onboarding/enrichment/sanitize");
  const { pickedSiteName } = await import("../site-name");
  const stored = (name: string) =>
    xmlEscapeContent(
      sanitizeFetchedContent(
        `A grooming salon in Pune named "Old Paws"\n\nAdditional context:\n- Name: The business is called "${name}".\n- Design: Playful`,
      ),
    );

  it.each(["Paws & Suds", "Joe's Diner", "Brightline"])("%s wins over the company, the workspace and a name in the idea", async (name) => {
    const extract = vi.fn(async () => "Model Guess");
    expect(await resolveSiteName({ idea: stored(name), company_name: "Acme Holdings", workspace_name: "Acme" }, { extract })).toBe(name);
    expect(extract).not.toHaveBeenCalled();
  });

  it.each(["24/7 Fitness", "Admin"])("a picked name the slug rules refuse (%s) is never used", async (name) => {
    expect(pickedSiteName(stored(name))).toBeNull();
    expect(await resolveSiteName({ idea: stored(name), company_name: "Acme Holdings", workspace_name: "Acme" })).not.toBe(name);
  });

  it("markdown in a picked name is stripped before it reaches a prompt", () => {
    expect(pickedSiteName(stored("Bold**Co`"))).toBe("BoldCo");
  });
});

describe("siteBrandName puts the picked name first", () => {
  it("brands the build with the clarify pick over a name the idea calls it and over the founder's name", async () => {
    const { sanitizeFetchedContent, xmlEscapeContent } = await import("@/services/onboarding/enrichment/sanitize");
    const idea = xmlEscapeContent(
      sanitizeFetchedContent('A salon named "Old Paws"\n\nAdditional context:\n- Name: The business is called "Paws & Suds".'),
    );
    expect(siteBrandName({ idea, siteName: "Old Paws", founderName: "Acme Holdings" })).toEqual({ name: "Paws & Suds", from: "idea" });
  });

  it("falls back to main's order when the pick is one the address rules refuse", async () => {
    const { sanitizeFetchedContent, xmlEscapeContent } = await import("@/services/onboarding/enrichment/sanitize");
    const idea = xmlEscapeContent(sanitizeFetchedContent('A gym\n\nAdditional context:\n- Name: The business is called "Admin".'));
    expect(siteBrandName({ idea, siteName: null, founderName: "Iron Works" })).toEqual({ name: "Iron Works", from: "founder" });
  });
});
