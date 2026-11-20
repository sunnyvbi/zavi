import { describe, it, expect } from "vitest";
import { cleanSiteLabel, cleanSiteName, explicitName, siteDisplayName, siteHostname, siteHostnameConfig, siteIdSuffix, siteLabel, siteLabelName } from "../label";
import { tenantSuffix } from "@/services/provisioning/tenant-slug";
import { RESERVED_LABELS, validateBuiltinLabel } from "@/services/provisioning/builtin-url";

const T = "11111111-1111-4111-8111-111111111111";
const S = "abcdef12-3456-4789-8abc-def012345678";

describe("site label", () => {
  it("is <company slug>-<tenant hash8>-<site id6>", () => {
    expect(siteIdSuffix(S)).toBe("abcdef");
    expect(siteLabel("Acme Bikes!", T, S)).toBe(`acme-bikes-${tenantSuffix(T)}-abcdef`);
    expect(siteHostname("x-1", { suffix: "", base_domain: "zaviagent.com" })).toBe("x-1.zaviagent.com");
  });

  it("caps the company part at 24 chars with no trailing hyphen, and falls back to 'company'", () => {
    const l = siteLabel("A very long company name that goes on", T, S);
    expect(l.split("-").slice(0, -2).join("-").length).toBeLessThanOrEqual(24);
    expect(l).not.toMatch(/--/);
    expect(siteLabel("!!!", T, S)).toBe(`company-${tenantSuffix(T)}-abcdef`);
  });

  it("always yields a valid, non-reserved built-in label", () => {
    for (const name of ["api", "www", "Admin", "", "é", "x".repeat(100)]) {
      const l = siteLabel(name, T, S);
      expect(validateBuiltinLabel(l)).toEqual({ ok: true, label: l });
      expect(RESERVED_LABELS.has(l)).toBe(false);
    }
  });
});

describe("site label from the site's own name (DEL-1323 B33/B24)", () => {
  it("is <site name slug>-<tenant hash8>-<site id6>, never the workspace name, when the site has a name", () => {
    expect(siteLabel("Apna Tutor", T, S, "Paws & Suds")).toBe(`paws-suds-${tenantSuffix(T)}-abcdef`);
    expect(siteLabel("Apna Tutor", T, S, "Paws & Suds")).not.toContain("apna");
  });

  it("two sites of one workspace keep the tenant hash and differ by name and id", () => {
    const S2 = "123456ab-0000-4000-8000-000000000000";
    const a = siteLabel("Apna Tutor", T, S, "Paws and Suds");
    const b = siteLabel("Apna Tutor", T, S2, "Still Water Yoga");
    expect(a).toBe(`paws-and-suds-${tenantSuffix(T)}-abcdef`);
    expect(b).toBe(`still-water-yoga-${tenantSuffix(T)}-123456`);
  });

  it("a name with no usable letters falls back to the workspace name, then to 'company'", () => {
    expect(siteLabel("Apna Tutor", T, S, "!!!")).toBe(`apna-tutor-${tenantSuffix(T)}-abcdef`);
    expect(siteLabel("Apna Tutor", T, S, "   ")).toBe(`apna-tutor-${tenantSuffix(T)}-abcdef`);
    expect(siteLabel("Apna Tutor", T, S, null)).toBe(`apna-tutor-${tenantSuffix(T)}-abcdef`);
    expect(siteLabel("!!!", T, S, "@@@")).toBe(`company-${tenantSuffix(T)}-abcdef`);
  });

  it("caps the name part at 24 chars and still yields a valid built-in label", () => {
    const l = siteLabel("Apna Tutor", T, S, "The Extremely Long Neighbourhood Dog Grooming Parlour");
    expect(l).toBe(`the-extremely-long-neigh-${tenantSuffix(T)}-abcdef`);
    for (const name of ["api", "www", "Admin", "é", "x".repeat(100), "a-", "-a-"]) {
      const label = siteLabel("Apna Tutor", T, S, name);
      expect(validateBuiltinLabel(label)).toEqual({ ok: true, label });
    }
  });

  it("cleanSiteName never cuts an emoji in half at the 60 cap", () => {
    const out = cleanSiteName(`${"a".repeat(59)}\u{1F436} Paws`) ?? "";
    expect(out).toBe(`${"a".repeat(59)}\u{1F436}`);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false);
    expect(encodeURIComponent(out)).toBeTruthy();
  });

  it("cleanSiteName collapses whitespace and control characters and caps at 60", () => {
    expect(cleanSiteName("  Paws\n\tand   Suds ")).toBe("Paws and Suds");
    expect(cleanSiteName("\u0000\u0007")).toBeNull();
    expect(cleanSiteName("y".repeat(80))).toBe("y".repeat(60));
    expect(cleanSiteName(null)).toBeNull();
  });
});

describe("site hostname config (per environment)", () => {
  it("prod has no suffix: <label>.zaviagent.com", () => {
    const cfg = siteHostnameConfig({});
    expect(cfg).toEqual({ suffix: "", base_domain: "zaviagent.com" });
    expect(siteHostname("acme-1a2b3c4d-abcdef", cfg)).toBe("acme-1a2b3c4d-abcdef.zaviagent.com");
  });

  it("dev appends -dev to the label, same zone: <label>-dev.zaviagent.com", () => {
    const cfg = siteHostnameConfig({ SITE_HOSTNAME_SUFFIX: "-dev" });
    expect(siteHostname("acme-1a2b3c4d-abcdef", cfg)).toBe("acme-1a2b3c4d-abcdef-dev.zaviagent.com");
    const long = siteLabel("x".repeat(100), T, S) + "-abcdefghij";
    expect(long.length).toBeLessThanOrEqual(63);
  });

  it("honours PRAXIS_PRODUCT_DOMAIN", () => {
    expect(siteHostnameConfig({ PRAXIS_PRODUCT_DOMAIN: "example.dev" }).base_domain).toBe("example.dev");
  });

  it("rejects a bad suffix or domain instead of falling back to prod", () => {
    for (const bad of ["dev", "-", "-DEV", "-dev.x", ".dev", "-abcdefghijk", "--dev", "-d_v"]) {
      expect(() => siteHostnameConfig({ SITE_HOSTNAME_SUFFIX: bad }), bad).toThrow(/SITE_HOSTNAME_SUFFIX/);
    }
    for (const bad of ["", "zaviagent", "Zaviagent.com", "a..com", "-a.com", "a.com/", "a.com.", "evil.com:80"]) {
      expect(() => siteHostnameConfig({ PRAXIS_PRODUCT_DOMAIN: bad }), bad).toThrow(/base domain/);
    }
  });
});

describe("siteLabelName (the site's own name for its address)", () => {
  const ws = "Apna Tutor";
  const name = (idea: string, company_name = ws, workspace_name: string | null = ws) =>
    siteLabelName({ idea, company_name, workspace_name });

  it("names the business the site is for, not the workspace", () => {
    expect(name("A booking website for my dog grooming salon. Show services with prices, let customers pick a time slot and book.")).toBe("dog grooming salon");
    expect(name("A simple booking website for a bike repair shop: list services with prices")).toBe("bike repair shop");
    expect(name("i want ot make landing page for my cake shop")).toBe("cake shop");
    expect(name("A simple website for Sweet Crumb Bakery in Austin: menu with prices")).toBe("sweet crumb bakery");
  });

  it("an explicit name in the idea wins", () => {
    expect(name("Create a modern and responsive Event Management Website called Evently. The platform should let users discover events")).toBe("evently");
    expect(name('A portfolio site named "Blue Fern Studio" with a gallery')).toBe("blue fern studio");
  });

  it("a product name the founder typed (not the workspace name) wins over the idea", () => {
    expect(name("A multiplayer puzzle game designed for play between friends", "Puzzle Night")).toBe("Puzzle Night");
    expect(name("A booking website for my dog grooming salon", "apna tutor", "Apna Tutor")).toBe("dog grooming salon");
    expect(name("A booking website for my dog grooming salon", "My Company", null)).toBe("dog grooming salon");
  });

  it("an unknown workspace name never lets the company name beat the idea", () => {
    expect(name("A booking website for my dog grooming salon. Show services with prices", "Apna Tutor", null)).toBe("dog grooming salon");
    expect(name("A booking website for my dog grooming salon", "Apna Tutor", undefined as unknown as null)).toBe("dog grooming salon");
    expect(name("make a website please", "Acme", null)).toBe("Acme");
  });

  it("without a 'for' phrase it takes the first content words", () => {
    expect(name("Multiplayer puzzle game with rooms and a leaderboard")).toBe("multiplayer puzzle game");
  });

  it("a described business is named for what it is and where, never for the verb", () => {
    expect(name("I run a home cleaning service in San Jose")).toBe("home cleaning san jose");
    expect(name("I own a dog grooming business in Austin")).toBe("dog grooming austin");
    expect(name("We operate a car detailing company near Denver")).toBe("car detailing denver");
    expect(name("I'm starting a bakery")).toBe("bakery");
    expect(name("I started a yoga studio in Portland, Oregon last year")).toBe("yoga studio portland oregon");
    for (const idea of ["I run a home cleaning service in San Jose", "I have a plumbing business", "I manage a nail salon in Fresno"]) {
      expect(name(idea)).not.toMatch(/\b(run|have|manage|own|service|business)\b/);
    }
  });

  it("the address is built from the same plain name", () => {
    const n = name("I run a home cleaning service in San Jose");
    expect(cleanSiteLabel("Apna Tutor", S, n)).toBe("home-cleaning-san-jose");
  });

  it("falls back to the company name when the idea has nothing usable", () => {
    expect(name("make a website please", "Acme")).toBe("Acme");
    expect(name("!!!", ws)).toBe(ws);
  });

  it("always yields a valid, non-reserved label through siteLabel", () => {
    for (const idea of ["A booking website for my dog grooming salon", "api", "www admin", "é", "x".repeat(400)]) {
      const l = siteLabel(name(idea), T, S);
      expect(validateBuiltinLabel(l)).toEqual({ ok: true, label: l });
    }
    expect(siteLabel(name("A booking website for my dog grooming salon"), T, S)).toBe(`dog-grooming-salon-${tenantSuffix(T)}-abcdef`);
  });
});

describe("siteDisplayName (QA B24)", () => {
  it("drops the tenant hash and site id from the label", () => {
    expect(siteDisplayName("mile-high-coffee-693dfbdb-523441")).toBe("Mile High Coffee");
    expect(siteDisplayName("lucky-paws-grooming-693dfbdb-687f66")).toBe("Lucky Paws Grooming");
  });

  it("keeps a label that does not end in the hash pair, and never returns empty", () => {
    expect(siteDisplayName("shop-2026")).toBe("Shop 2026");
    expect(siteDisplayName("")).toBe("Untitled site");
    expect(siteDisplayName(null)).toBe("Untitled site");
  });

  it("round-trips siteLabel", () => {
    const label = siteLabel("Mile High Coffee", "6fcb0904-4e2b-41dc-aa92-83810a902d2d", "523441c7-f3b8-4593-b6be-0bd687386797");
    expect(siteDisplayName(label)).toBe("Mile High Coffee");
  });
});

describe("cleanSiteLabel (new sites: the plain name, a suffix only on a clash)", () => {
  it("is the plain name slug on the first try", () => {
    expect(cleanSiteLabel("Apna Tutor", S, "Home Cleaning San Jose")).toBe("home-cleaning-san-jose");
    expect(cleanSiteLabel("Mile High Coffee", S)).toBe("mile-high-coffee");
  });

  it("adds the 6-hex site id only on a retry or when the name is too short", () => {
    expect(cleanSiteLabel("Apna Tutor", S, "Paws & Suds", false)).toBe("paws-suds-abcdef");
    expect(cleanSiteLabel("Apna Tutor", S, "Jo")).toBe("jo-abcdef");
    expect(cleanSiteLabel("!!!", S, "@@@")).toBe("site-abcdef");
  });

  it("keeps at most 40 characters and never ends in a hyphen", () => {
    const l = cleanSiteLabel("Apna Tutor", S, "The Extremely Long Neighbourhood Dog Grooming Parlour");
    expect(l.length).toBeLessThanOrEqual(40);
    expect(l).not.toMatch(/-$/);
  });

  it("shows the plain name back, with or without the clash suffix", () => {
    expect(siteDisplayName(cleanSiteLabel("Apna Tutor", S, "Home Cleaning San Jose"))).toBe("Home Cleaning San Jose");
    expect(siteDisplayName("paws-and-suds-3f9a1c")).toBe("Paws And Suds");
    expect(siteDisplayName("cafe-facade")).toBe("Cafe Facade");
    expect(siteDisplayName("bakery-123456")).toBe("Bakery 123456");
  });
});

describe("an escaped '&' in the idea (QA 2026-10-01, Rise Amp)", () => {
  const ESCAPED = "A website for Rise &amp; Shine Bakery, a bakery in Denver, with our breads and pastries with prices and an order form.";
  const name = (idea: string, company_name = "Apna Tutor", workspace_name: string | null = "Apna Tutor") =>
    siteLabelName({ idea, company_name, workspace_name });

  it("names the business with its '&', never 'amp'", () => {
    expect(name(ESCAPED)).toBe("rise & shine bakery");
    expect(name(ESCAPED.replace("&amp;", "&"))).toBe("rise & shine bakery");
    expect(name(ESCAPED.replace("&amp;", "&amp;amp;"))).toBe("rise & shine bakery");
  });

  it("keeps '&' in explicit and typed names, and never as a first or last word", () => {
    expect(name("A cafe website called Salt &amp; Pepper")).toBe("salt & pepper");
    expect(name("A website for my bakery", "Rise &amp; Shine", "Apna Tutor")).toBe("Rise & Shine");
    expect(name("A website for & the bakery &")).toBe("bakery");
  });

  it("slugs '&' away in the label and the hostname", () => {
    const l = siteLabel("Apna Tutor", T, S, cleanSiteName("Rise &amp; Shine Bakery"));
    expect(l).toBe(`rise-shine-bakery-${tenantSuffix(T)}-abcdef`);
    expect(l).not.toContain("amp");
    expect(validateBuiltinLabel(l)).toEqual({ ok: true, label: l });
  });

  it("cleanSiteName decodes entities so every display surface shows '&'", () => {
    expect(cleanSiteName("Rise &amp; Shine Bakery")).toBe("Rise & Shine Bakery");
    expect(cleanSiteName("Rise &amp;amp; Shine")).toBe("Rise & Shine");
    expect(cleanSiteName("Tom &apos;s &lt;Diner&gt;")).toBe("Tom 's <Diner>");
  });
});

describe("the logo answer never names the site", () => {
  it("a logo described as something 'named' is not the business name", () => {
    const idea =
      "A site for my pet sitting service\n\nAdditional context:\n- Name: No name yet. Suggest a short, memorable name for the business and use it on the site.\n- Logo: Make a logo mark showing: a fox named Rocket.";
    expect(siteLabelName({ idea, company_name: "My Company", workspace_name: "Acme" })).toBe("pet sitting service");
    const named = `${idea}\n- Name: The business is called "Tails Up".`;
    expect(siteLabelName({ idea: named, company_name: "My Company", workspace_name: "Acme" })).toBe("tails up");
  });
});

describe("the build questions' context block never names the site", () => {
  const name = (idea: string) => siteLabelName({ idea, company_name: "Yoga Studio", workspace_name: "Yoga Studio" });

  it("the heading after an unpunctuated idea is not read as part of the name (Cake Rental Additional)", () => {
    const idea =
      "help me to make the cake rental website Additional context: - Name: Use the business name given in the idea above. - Audience: Consumers - Core action: Take and buy a cake.";
    expect(name(idea)).toBe("cake rental");
    expect(name(idea.replace(" Additional context:", "\n\nAdditional context:\n"))).toBe("cake rental");
  });

  it("a name the founder states in plain words is the site's name", () => {
    expect(name("A cake shop website. The name of the website will be Cakee. Anybody can order.")).toBe("cakee");
    expect(name("cake shop site, website name is \"Cakee by AE\"")).toBe("cakee by ae");
    expect(explicitName("Make a bakery site. Name will be Sweet Crumbs and it sells bread")).toBe("Sweet Crumbs");
    expect(explicitName("Call it Velvet Oven")).toBe("Velvet Oven");
  });

  it("a relational 'named after/for' is not a name", () => {
    expect(explicitName("Build a bakery named after my grandmother for local customers to order cakes")).toBeNull();
    expect(explicitName("A dog walking app named for my late dog")).toBeNull();
    expect(explicitName("A nonprofit called For Good")).toBe("For Good");
  });

  it("answers in the context block and request filler never become an explicit name", () => {
    expect(explicitName("help me make a cake site Additional context: - Name: Use the business name given in the idea above.")).toBeNull();
    expect(explicitName("the name will be the best one for kids")).toBeNull();
    expect(explicitName("Hi, my name is Ravi and I run a bakery in Pune")).toBeNull();
    expect(explicitName('my name is "Ravi", I bake cakes')).toBeNull();
    expect(explicitName("a cake shop, name it something fun")).toBeNull();
    expect(siteLabelName({ idea: "Hi, my name is Ravi and I want a website for my bakery", company_name: "Yoga Studio", workspace_name: "Yoga Studio" })).toBe("bakery");
    expect(explicitName("Our name is Cakee and we bake")).toBe("Cakee");
    expect(explicitName("A cake site Additional context:\n- Name: The business is called \"Cakey\".")).toBe("Cakey");
  });
});

describe("personal introductions before a business name", () => {
  it.each([
    "My name is Ravi. My bakery is called Blue Fern",
    'My name is "Ravi". My bakery is called "Blue Fern"',
    "My company name is Blue Fern",
    "My name is Ravi. Name it something fun. The business name is Blue Fern",
  ])("uses the business name in %s", (idea) => {
    expect(explicitName(idea)).toBe("Blue Fern");
    expect(siteLabelName({ idea, company_name: "My Company", workspace_name: "My Company" })).toBe("blue fern");
  });
  it("does not turn a personal introduction into a site label", () => {
    expect(explicitName("Hi, my name is Ravi. Build a website for a bakery")).toBeNull();
    expect(siteLabelName({ idea: "Hi, my name is Ravi. Build a website for a bakery", company_name: "My Company", workspace_name: "My Company" })).toBe("bakery");
    expect(siteLabelName({ idea: "My name is Ravi", company_name: "My Company", workspace_name: "My Company" })).toBe("My Company");
  });
});

it.each(["My first name is Ravi", "My full name is Ravi", "I am called Ravi"])("does not infer a business name from %s", (idea) => {
  expect(explicitName(idea)).toBeNull();
  expect(siteLabelName({ idea, company_name: "My Company", workspace_name: "My Company" })).toBe("My Company");
  expect(explicitName(`${idea}. My bakery is called Blue Fern`)).toBe("Blue Fern");
});

describe("a business the founder says they run is its name", () => {
  const PRIYA = "I'm Priya Shah and I run Saffron Spoon, a small Indian catering business in Austin. I want a website where people can browse our menus.";
  it.each([
    [PRIYA, "Saffron Spoon"],
    ["We own Rise & Shine Bakery in Austin and need a site", "Rise & Shine Bakery"],
    ["I started The Daily Grind. Make me a cafe site", "The Daily Grind"],
  ])("%s", (idea, name) => {
    expect(explicitName(idea)).toBe(name);
    expect(siteLabelName({ idea, company_name: "My Company", workspace_name: "My Company" })).toBe(name.toLowerCase());
  });

  it.each([
    "We run Instagram ads for local gyms and need a landing page",
    "I run Facebook ads, need a site",
    "I run a small bakery in Pune",
    "I'm Priya Shah, make me a site",
    "We started 2021, and now want a website",
    "I run Shopify, need a site",
    "I run Airbnb in Goa",
    "I run Google Ads at Acme",
    "I opened 2 Cafes in Pune",
    "We manage Airbnb listings in Goa",
  ])("is not fooled by %s", (idea) => {
    expect(explicitName(idea)).toBeNull();
  });
});
