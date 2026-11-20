import { describe, expect, it, vi } from "vitest";
import { heuristicLogoDesign, LOGO_RENDER_PROMPT_MAX } from "../site-logo-design";
import type { SiteSandbox } from "../contract";
import {
  cleanLogoRequest,
  generatedLogoUrl,
  generatedLogoPlan,
  buildLogoDescription,
  buildLogoDirection,
  prepareBuildLogo,
  liveBuildLogoDeps,
  prepareGeneratedLogo,
  siteLogoModelPrompt,
  siteTaglineFrom,
  logoBusinessFrom,
  type LogoGenerationDeps,
} from "../site-logo-generate";

function deps(over: Partial<LogoGenerationDeps> = {}): LogoGenerationDeps {
  return {
    configured: vi.fn(async () => true),
    estimate: vi.fn(async () => 0.08),
    afford: vi.fn(async () => "ok" as const),
    generate: vi.fn(async () => ({ ok: true as const, url: "https://vendor.example/logo.svg", cost_usd: 0.08, model: "recraft" })),
    download: vi.fn(async () => new TextEncoder().encode('<svg viewBox="0 0 64 64"><path d="M0 0L8 8"/></svg>')),
    ...over,
  };
}

describe("site logo generation", () => {
  it("cleans the founder request and builds a contextual symbol-only prompt", () => {
    expect(cleanLogoRequest({ description: "  a flowing   hummingbird " })).toEqual({ description: "a flowing hummingbird" });
    expect(cleanLogoRequest({ description: "x" })).toBeNull();
    const prompt = siteLogoModelPrompt({ site_name: "Flight Club", description: "a flowing hummingbird", primary: "#123456", accent: "#abcdef" });
    expect(prompt).toContain("Flight Club");
    expect(prompt).toContain("a flowing hummingbird");
    expect(prompt).toContain("#123456 and #abcdef");
    expect(prompt).toContain("no text, letters or initials");
  });

  it("lets a monogram use initials, and turns a wordmark request into a symbol (the model never draws the name)", () => {
    const monogram = siteLogoModelPrompt({ site_name: "Crumb & Co", description: "A bold monogram of the initials" });
    expect(monogram).toContain('"CC"');
    expect(monogram).not.toMatch(/no text, letters or initials/);
    const wordmark = siteLogoModelPrompt({ site_name: "Crumb & Co", description: "a wordmark with a flour-dust detail" });
    expect(wordmark).not.toContain('"Crumb & Co"');
    expect(wordmark).toMatch(/no text, letters or initials/);
    expect(siteLogoModelPrompt({ site_name: "Crumb & Co", description: "a croissant", business: "a pastry delivery bakery" })).toContain("Crumb & Co, a pastry delivery bakery");
  });


  it("checks affordability, sanitizes the SVG, and records actual cost", async () => {
    const d = deps({
      download: vi.fn(async () => new TextEncoder().encode('<svg viewBox="0 0 64 64" onload="bad()"><style>@import url(//evil)</style><path d="M0 0"/></svg>')),
    });
    const result = await prepareGeneratedLogo({ tenant_id: "t1", site_name: "Acme", request: { description: "an angular fox" } }, d);
    expect(result).toMatchObject({ model: "recraft", cost_usd: 0.08, charge: { task: "image.vector", cost_usd: 0.08 } });
    expect("svg" in result ? result.svg : "").not.toMatch(/onload|<style|evil/i);
    expect(d.afford).toHaveBeenCalledWith("t1", 0.08);
  });

  it("returns a Recraft logo with its <metadata> block intact, not a half-stripped one an <img> cannot draw", async () => {
    const recraft =
      '<svg xmlns="http://www.w3.org/2000/svg" height="1536" style="display: block;" version="1.1" viewBox="0 0 3072 1536" width="3072">\n' +
      '<path d="M 0 0 L 3072 0 L 3072 1536 L 0 1536 L 0 0 z" fill="rgb(243,89,43)" transform="translate(0,0)"></path>\n' +
      '<metadata><recraft-signature>{"signed_by": "recraft", "signing_algo": "Ed25519"}</recraft-signature></metadata></svg>';
    const d = deps({ download: vi.fn(async () => new TextEncoder().encode(recraft)) });
    const result = await prepareGeneratedLogo({ tenant_id: "t1", site_name: "Butter & Crumb", request: { description: "an abstract mark" } }, d);
    const svg = "svg" in result ? result.svg : "";
    expect(svg).toContain("<metadata><recraft-signature>");
    expect(svg).toContain("</recraft-signature></metadata></svg>");
    expect(svg.match(/<metadata\b/g)?.length).toBe(1);
    expect(svg.match(/<\/metadata>/g)?.length).toBe(1);
  });

  it("does not call the vendor when credits are short and rejects malformed output", async () => {
    const short = deps({ afford: vi.fn(async () => "short" as const) });
    expect(await prepareGeneratedLogo({ tenant_id: "t1", site_name: "Acme", request: { description: "an angular fox" } }, short)).toEqual({ reason: "insufficient_credits" });
    expect(short.generate).not.toHaveBeenCalled();

    const unsafe = deps({ download: vi.fn(async () => new TextEncoder().encode("not svg")) });
    expect(await prepareGeneratedLogo({ tenant_id: "t1", site_name: "Acme", request: { description: "an angular fox" } }, unsafe)).toEqual({ reason: "unsafe_svg" });
  });

  it("changes logo, favicon and the header reference together and refuses a stale snapshot", async () => {
    const prepared = { svg: '<svg viewBox="0 0 1 1"></svg>\n', model: "m", cost_usd: 0.08, charge: { task: "image.vector" as const, cost_usd: 0.08 } };
    const site = 'export const SITE = {\n  name: "Acme",\n  tagline: "Tools",\n};\n';
    const app = "export function App() { return <SiteHeader logo={SITE.logo} />; }\n";
    const readFile = vi.fn(async (path: string) =>
      path.endsWith("SiteHeader.tsx") ? Promise.reject(new Error("missing")) : path.endsWith("logo.svg") ? "old-logo" : path.endsWith("favicon.svg") ? "old-favicon" : path.endsWith("App.tsx") ? app : site,
    );
    const plan = await generatedLogoPlan(prepared, { logo: "old-logo", favicon: "old-favicon", site, app })({ readFile } as unknown as SiteSandbox);
    const logoUrl = generatedLogoUrl(prepared.svg);
    expect(logoUrl).toMatch(/^\/images\/logo\.svg\?v=[0-9a-f]{12}$/);
    expect(plan).toEqual({
      label: "Changed the site logo",
      files: [
        { path: "public/images/logo.svg", before: "old-logo", after: prepared.svg },
        { path: "public/favicon.svg", before: "old-favicon", after: prepared.svg },
        { path: "src/site.ts", before: site, after: `export const SITE = {\n  name: "Acme",\n  logo: ${JSON.stringify(logoUrl)},\n  tagline: "Tools",\n};\n` },
      ],
    });
    const stale = await generatedLogoPlan(prepared, { logo: "different", favicon: "old-favicon", site, app })({ readFile } as unknown as SiteSandbox);
    expect(stale).toEqual({ reason: "changed" });
  });

  it("changes the public logo URL when the generated artwork changes", () => {
    expect(generatedLogoUrl('<svg viewBox="0 0 1 1"><path d="M0 0"/></svg>')).not.toBe(
      generatedLogoUrl('<svg viewBox="0 0 1 1"><path d="M1 1"/></svg>'),
    );
  });

  it("refuses when the site cannot reference the generated logo", async () => {
    const prepared = { svg: '<svg viewBox="0 0 1 1"></svg>\n', model: "m", cost_usd: 0.08, charge: { task: "image.vector" as const, cost_usd: 0.08 } };
    const site = "export const x = 1;\n";
    const app = "export function App() { return null; }\n";
    const readFile = vi.fn(async (path: string) =>
      path.endsWith("SiteHeader.tsx") ? Promise.reject(new Error("missing")) : path.endsWith("logo.svg") ? "old-logo" : path.endsWith("favicon.svg") ? "old-favicon" : path.endsWith("App.tsx") ? app : site,
    );
    const plan = await generatedLogoPlan(prepared, { logo: "old-logo", favicon: "old-favicon", site, app })({ readFile } as unknown as SiteSandbox);
    expect(plan).toEqual({ reason: "logo_slot_unavailable" });
  });
});

describe("a new build's logo (Zavi pays)", () => {
  it("never reads or checks the tenant's credits, and logs the vendor cost", async () => {
    const { afford: _afford, ...d } = deps();
    const log = vi.fn();
    const out = await prepareBuildLogo({ tenant_id: "t1", run_id: "r1", site_name: "North Fork Bikes", idea: "A bike repair shop\n\nAdditional context:\n- Name: x" }, d, log);
    expect("svg" in out && out.svg).toContain("<svg");
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ model: "recraft", cost_usd: 0.08 }), true);
    const prompt = (d.generate as ReturnType<typeof vi.fn>).mock.calls[0]![1].prompt as string;
    expect(prompt).toContain("A bike repair shop");
    expect(prompt).not.toContain("Additional context");
  });

  it("a failure is a reason, logged as a warning, never a throw", async () => {
    const { afford: _afford, ...d } = deps({ generate: vi.fn(async () => { throw new Error("vendor down"); }) });
    const log = vi.fn();
    expect(await prepareBuildLogo({ tenant_id: "t1", run_id: "r1", site_name: "", idea: "A bakery" }, d, log)).toEqual({ reason: "generation_failed" });
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ skipped_reason: "generation_failed" }), false);
    expect(buildLogoDescription("x".repeat(900)).length).toBeLessThanOrEqual(400);
  });
});

describe("logo colours reach the model", () => {
  it("turns the theme's hex colours into RGB on the request and skips a malformed one", async () => {
    const generate = vi.fn(async () => ({ ok: false as const, reason: "vendor_error" as const, error: "x" }));
    await prepareGeneratedLogo(
      { tenant_id: "t", site_name: "Crumb & Co", request: { description: "a croissant" }, primary: "#f0956b", accent: "not-a-colour", zaviPays: true },
      { configured: async () => true, estimate: async () => 0.08, afford: async () => "ok", generate, download: async () => null },
    );
    expect((generate.mock.calls[0] as unknown[])[1]).toMatchObject({ colors: [{ r: 240, g: 149, b: 107 }] });
  });
});

describe("the designer's spec drives the vendor prompt", () => {
  const spec = {
    type: "pictorial" as const,
    subject: "a heron whose neck forms the letter S",
    concept: "Patience and precision",
    style: "negative-space" as const,
    rationale: "Customers know the bird.",
    avoid: ["a swoosh"],
    source: "founder" as const,
  };

  it("prepareGeneratedLogo renders the designed brief instead of the raw founder words and carries the spec to the caller", async () => {
    const d = deps();
    const result = await prepareGeneratedLogo(
      { tenant_id: "t1", site_name: "Still Water", request: { description: "something with a bird" }, primary: "#123456", design: spec },
      d,
    );
    const req = (d.generate as ReturnType<typeof vi.fn>).mock.calls[0]![1] as { prompt: string; colors?: unknown[] };
    expect(req.prompt).toContain("A pictorial mark: a heron whose neck forms the letter S.");
    expect(req.prompt).toContain("Avoid: clip art, generic stock icons, a swoosh.");
    expect(req.prompt).not.toContain("something with a bird");
    expect(req.colors).toEqual([{ r: 0x12, g: 0x34, b: 0x56 }]);
    expect("design" in result && result.design).toEqual(spec);
  });

  it("reads the founder's logo direction out of the build idea, and nothing when none was given", () => {
    expect(buildLogoDirection("A bakery.\n\nAdditional context:\n- Logo: no logo")).toBeNull();
    expect(buildLogoDirection("A bakery.\n\nAdditional context:\n- Logo: yes")).toBeNull();
    expect(buildLogoDirection("A bakery.\n\nAdditional context:\n- Logo: make a logo mark showing a wheat ear curling into steam")).toBe("a wheat ear curling into steam");
    expect(buildLogoDirection("A bakery in Leeds. Please use a wordmark for the logo. We open at 7.")).toBe("Please use a wordmark for the logo.");
    expect(buildLogoDirection("A bakery in Leeds with no initials on the sign.")).toBeNull();
  });

  it("a build asks the designer with the idea's first paragraph and the founder's logo line, then draws what it chose", async () => {
    const design = vi.fn(async () => ({ spec, ms: 12, reason: null }));
    const d = { ...deps(), design };
    const log = vi.fn();
    const idea = "A family photography studio in Leeds.\n\nAdditional context:\n- Logo: make a logo mark showing a heron";
    const out = await prepareBuildLogo({ tenant_id: "t1", run_id: "r1", site_name: "Still Water", idea }, d, log);
    expect(design).toHaveBeenCalledWith({ site_name: "Still Water", business: "A family photography studio in Leeds.", direction: "a heron" });
    const req = (d.generate as ReturnType<typeof vi.fn>).mock.calls[0]![1] as { prompt: string };
    expect(req.prompt).toContain("a heron whose neck forms the letter S");
    expect(req.prompt).not.toContain("a distinctive mark a customer would instantly read");
    expect("svg" in out).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ design_type: "pictorial", design_source: "founder", design_ms: 12 }), true);
  });

  it("a designer that fails never costs the build its logo: the plain brief is drawn instead", async () => {
    const d = { ...deps(), design: vi.fn(async () => Promise.reject(new Error("down"))) };
    const log = vi.fn();
    const out = await prepareBuildLogo({ tenant_id: "t1", run_id: "r1", site_name: "Still Water", idea: "A family photography studio." }, d, log);
    expect(d.design).toHaveBeenCalledTimes(1);
    expect(d.design).toHaveBeenCalledWith({ site_name: "Still Water", business: "A family photography studio.", direction: null });
    expect("svg" in out).toBe(true);
    const req = (d.generate as ReturnType<typeof vi.fn>).mock.calls[0]![1] as { prompt: string };
    expect(req.prompt).toContain("a distinctive mark a customer would instantly read");
    expect(log).toHaveBeenCalledWith(expect.not.objectContaining({ design_type: expect.anything() }), true);
  });
});

describe("prompt hygiene from the review of the plain prompt", () => {
  it("sends a 3-digit hex colour to the vendor as RGB", async () => {
    const d = deps();
    await prepareGeneratedLogo({ tenant_id: "t1", site_name: "Acme", request: { description: "a fox" }, primary: "#abc" }, d);
    expect((d.generate as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toMatchObject({ colors: [{ r: 170, g: 187, b: 204 }] });
  });

  it("never spells a placeholder name: a monogram request without a real name draws a symbol", () => {
    const prompt = siteLogoModelPrompt({ site_name: "this business", description: "A bold monogram of the initials" });
    expect(prompt).toContain("no text, letters or initials");
    expect(prompt).not.toContain('"TB"');
    expect(siteLogoModelPrompt({ site_name: "Crumb & Co", description: "no initials, a croissant" })).toContain("no text, letters or initials");
  });

  it("caps the plain prompt by dropping the business line, then shortening the direction", () => {
    const prompt = siteLogoModelPrompt({ site_name: "Acme", description: "d".repeat(400), business: "b".repeat(160), primary: "#123456", accent: "#abcdef" });
    expect(prompt.length).toBeLessThanOrEqual(1000);
    expect(prompt).not.toContain("b".repeat(160));
    expect(prompt).toContain("Palette: #123456 and #abcdef");
  });
});

describe("the designer runs only once the logo can be paid for", () => {
  it("never calls the designer for a tenant short on credits, and calls it once when they can pay", async () => {
    const generate = vi.fn(async () => ({ ok: false as const, reason: "vendor_error" as const, error: "x" }));
    const base = { configured: async () => true, estimate: async () => 0.08, generate, download: async () => null };
    const designLater = vi.fn(async () => null);
    const short = await prepareGeneratedLogo({ tenant_id: "t", site_name: "Acme", request: { description: "a fox" }, designLater }, { ...base, afford: async () => "short" as const });
    expect(short).toEqual({ reason: "insufficient_credits" });
    expect(designLater).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    await prepareGeneratedLogo({ tenant_id: "t", site_name: "Acme", request: { description: "a fox" }, designLater }, { ...base, afford: async () => "ok" as const });
    expect(designLater).toHaveBeenCalledTimes(1);
  });
});



describe("live build logo design", () => {
  it("logs a bounded designer reason without vendor error text", async () => {
    const { afford: _afford, ...d } = deps();
    d.design = async (input) => ({ spec: heuristicLogoDesign(input), ms: 2, reason: "model_error: private vendor response" });
    const log = vi.fn();
    await prepareBuildLogo({ tenant_id: "t1", run_id: "r1", site_name: "Acme", idea: "A bakery" }, d, log);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ design_reason: "model_error" }), true);
  });

  it("uses immediate design without a model request or timeout", async () => {
    const design = await liveBuildLogoDeps().design!({ site_name: "Alpha Beta Company", business: "Consultancy", direction: "Use the initials ABC" });
    expect(design).toMatchObject({ reason: null, spec: { source: "founder", letters: "ABC" } });
  });
  it("passes available brand colours into rendering", async () => {
    const { afford: _afford, ...d } = deps();
    await prepareBuildLogo({ tenant_id: "t1", run_id: "r1", site_name: "Acme", idea: "A bakery", primary: "#123456", accent: "#abcdef" }, d, vi.fn());
    expect(d.generate).toHaveBeenCalledWith("image.vector", expect.objectContaining({ colors: [{ r: 18, g: 52, b: 86 }, { r: 171, g: 205, b: 239 }] }));
  });
});

it("preserves a founder's explicit pictorial instruction from the idea", async () => {
  const idea = "A bakery called Hush. Make the logo a fox curled around a loaf";
  expect(buildLogoDirection(idea)).toBe("Make the logo a fox curled around a loaf");
  const { afford: _afford, ...d } = deps();
  await prepareBuildLogo({ tenant_id: "t1", run_id: "r1", site_name: "Hush", idea }, { ...d, design: liveBuildLogoDeps().design }, vi.fn());
  expect(d.generate).toHaveBeenCalledWith("image.vector", expect.objectContaining({ prompt: expect.stringContaining("fox curled around a loaf") }));
});
it("preserves escaped initials through the stored build-input path", async () => {
  const { afford: _afford, ...d } = deps();
  await prepareBuildLogo({ tenant_id: "t1", run_id: "r1", site_name: "Hartwell Associates", idea: "A consultancy. Use the initials &quot;XYZ&quot; for a monogram" }, { ...d, design: liveBuildLogoDeps().design }, vi.fn());
  expect(d.generate).toHaveBeenCalledWith("image.vector", expect.objectContaining({ prompt: expect.stringContaining('"XYZ"') }));
});

it("prefers specific logo instructions after a generic request", () => {
  expect(buildLogoDirection("A consultancy called Hartwell Associates. Design a logo for it. Use initials XYZ for a monogram.")).toBe("Use initials XYZ for a monogram.");
  expect(buildLogoDirection("A bakery called Hush. Design a logo for it. Make the logo a fox curled around a loaf.")).toBe("Make the logo a fox curled around a loaf.");
  expect(buildLogoDirection("A bakery. The logo is not important.")).toBeNull();
  expect(buildLogoDirection("A bakery. Don't draw a logo of a fox.")).toBeNull();
  expect(buildLogoDirection("A bakery. Don’t draw a logo of a fox.")).toBeNull();
  expect(buildLogoDirection("A bakery. I don't want a logo of a fox.")).toBeNull();
  expect(buildLogoDirection("A bakery. Can you design a logo for it? Use initials HB for a monogram.")).toBe("Use initials HB for a monogram.");
});

it("keeps concrete logo requests ahead of unrelated type keywords", () => {
  expect(buildLogoDirection("A bakery called Hush. Draw a logo shaped like a fox curled around a loaf.")).toBe("Draw a logo shaped like a fox curled around a loaf.");
  expect(buildLogoDirection("A bakery called Hush. Make the logo a fox curled around a loaf. Use initials XYZ in customer avatars.")).toBe("Make the logo a fox curled around a loaf.");
});

it("ignores type words in sentences that are not about the logo", () => {
  expect(buildLogoDirection("An abstract-art portfolio. Make the logo a paintbrush.")).toBe("Make the logo a paintbrush.");
  expect(buildLogoDirection("A marketplace with a verified-seller badge for trusted sellers.")).toBeNull();
  expect(buildLogoDirection("A kids party business with a cartoon character host.")).toBeNull();
  expect(buildLogoDirection("Build a bakery called Hush. Use initials HB.")).toBe("Use initials HB.");
  expect(buildLogoDirection("A bakery. Design a logo please. Make it abstract.")).toBe("Make it abstract.");
});

it("skips generic named recipients without discarding subjects described after them", () => {
  expect(buildLogoDirection("A bakery called Hush. Design a logo for Hush. Make the logo a fox curled around a loaf.")).toBe("Make the logo a fox curled around a loaf.");
  expect(buildLogoDirection("A bakery called Hush. Design a logo for this bakery. Use initials HB for a monogram.")).toBe("Use initials HB for a monogram.");
  expect(buildLogoDirection("A bakery called Hush. Design a logo for Hush with a fox curled around a loaf.")).toBe("Design a logo for Hush with a fox curled around a loaf.");
});

it("keeps an affirmative type after a negated drawing request or a polite generic request", () => {
  expect(buildLogoDirection("A bakery called Hush. I don't want to draw a logo shaped like a fox. Use initials HB for a monogram.")).toBe("Use initials HB for a monogram.");
  expect(buildLogoDirection("A bakery called Hush. Design a logo please. Use initials HB for a monogram.")).toBe("Use initials HB for a monogram.");
});

it("preserves subject descriptions introduced by a colon after the recipient", () => {
  expect(buildLogoDirection("A bakery called Hush. Design a logo for Hush: a fox holding a loaf.")).toBe("Design a logo for Hush: a fox holding a loaf.");
});
describe("business context in the logo prompt", () => {
  const brief = {
    industry: "cake shop",
    audience: "families planning birthdays",
    positioning: "custom cakes baked the same morning",
    facts: ["Custom and ready-made cakes", "Local delivery included", "Order online", "Gluten-free on request", "Fifth fact"],
  };

  it("reads the tagline from the site config, unescaped, and ignores the starter's placeholder", () => {
    expect(siteTaglineFrom('export const SITE = { name: "A", tagline: "Fresh \\"daily\\" bakes" };')).toBe('Fresh "daily" bakes');
    expect(siteTaglineFrom("export const SITE = { tagline: 'Single quoted' };")).toBe("Single quoted");
    expect(siteTaglineFrom("export const SITE = { name: \"A\" };")).toBe("");
    expect(logoBusinessFrom(null, 'export const SITE = { tagline: "A new site, coming soon." };')).toEqual({});
  });

  it("keeps at most four offers and flattens anything that could break the prompt onto one line", () => {
    const b = logoBusinessFrom({ ...brief, industry: "cake\nshop\u0007" }, null);
    expect(b.industry).toBe("cake shop");
    expect(b.offers).toHaveLength(4);
  });

  it("puts the business before the founder's direction, and with no business the prompt is as before", () => {
    const withBusiness = siteLogoModelPrompt({ site_name: "Sweet Layers", description: "two overlapping shapes", business: logoBusinessFrom(brief, null) });
    expect(withBusiness.indexOf("About the business")).toBeLessThan(withBusiness.indexOf("Founder direction"));
    expect(siteLogoModelPrompt({ site_name: "Sweet Layers", description: "two overlapping shapes" })).not.toContain("About the business");
  });

  it("stays within the model's 1000 characters by dropping the least useful details first, never the direction or the rules", () => {
    const long = "x".repeat(150);
    const b = logoBusinessFrom({ industry: long, audience: long, positioning: long, facts: [long, long, long, long] }, `export const SITE = { tagline: "${long}" };`);
    const prompt = siteLogoModelPrompt({ site_name: "Sweet Layers", description: "d".repeat(400), primary: "#b0455f", accent: "#f3d9de", business: b });
    expect(prompt.length).toBeLessThanOrEqual(LOGO_RENDER_PROMPT_MAX);
    expect(prompt).toContain(`Founder direction: ${"d".repeat(400)}.`);
    expect(prompt).toContain("no text, letters or initials");
    expect(prompt).not.toContain("For:");
  });
});
