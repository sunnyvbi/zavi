import { describe, expect, it, vi } from "vitest";
import type { SiteSandbox } from "../contract";
import { THEME_PRESETS, renderThemeCss } from "@/services/provisioning/templates/vite-react-zavi/theme-presets";
import { siteSourceWithLogo, siteSourceWithoutLogo } from "../site-head";
import { logoRenderPrompt, heuristicLogoDesign } from "../site-logo-design";
import {
  cleanLogoRequest,
  logoMode,
  nameOnlyLogoPlan,
  prepareGeneratedLogo,
  siteNameFrom,
  siteLogoModelPrompt,
  type LogoGenerationDeps,
} from "../site-logo-generate";

function deps(svg: string, over: Partial<LogoGenerationDeps> = {}): LogoGenerationDeps {
  return {
    configured: vi.fn(async () => true),
    estimate: vi.fn(async () => 0.08),
    afford: vi.fn(async () => "ok" as const),
    generate: vi.fn(async () => ({ ok: true as const, url: "https://v/x.svg", cost_usd: 0.08, model: "recraft" })),
    download: vi.fn(async () => new TextEncoder().encode(svg)),
    ...over,
  };
}

describe("the image model never draws the business name", () => {
  const LETTERING = "Elegant hand-lettered wordmark of the name with a soft flourish";

  it("a request for lettering still asks for a symbol with no text, and is not passed on; a layout in the request is ignored", () => {
    expect(cleanLogoRequest({ description: "two shapes", layout: "wordmark" })).toEqual({ description: "two shapes" });
    expect(logoMode(LETTERING, "Sweet Layers")).toBe("symbol");
    const prompt = siteLogoModelPrompt({ site_name: "Sweet Layers", description: LETTERING });
    expect(prompt).toContain("no text, letters or initials");
    expect(prompt).not.toMatch(/Spell|set exactly|hand-lettered|wordmark/);
  });

  it("the designer never picks lettering, and an old lettering design draws an abstract mark", () => {
    const spec = heuristicLogoDesign({ site_name: "Sweet Layers", business: "a cake shop", direction: LETTERING });
    expect(spec.type).not.toBe("wordmark");
    expect(`${spec.subject} ${spec.concept}`).not.toMatch(/lettered|wordmark/);
    const prompt = logoRenderPrompt({ ...spec, type: "wordmark", style: "lettering", subject: "the name Sweet Layers" }, { site_name: "Sweet Layers" });
    expect(prompt).toContain("An abstract mark");
    expect(prompt).not.toMatch(/Spell|set exactly/);
  });

  it("initials stay available as a monogram", () => {
    expect(logoMode("A bold monogram of the initials", "Sweet Layers")).toBe("monogram");
  });

  it("every logo is a square symbol", async () => {
    const d = deps('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="10"/></svg>');
    const out = await prepareGeneratedLogo({ tenant_id: "t", site_name: "Sweet Layers", request: { description: "two shapes" }, zaviPays: true }, d);
    if ("reason" in out) throw new Error(out.reason);
    expect(((d.generate as ReturnType<typeof vi.fn>).mock.calls[0] as unknown as [string, { aspect_ratio: string }])[1].aspect_ratio).toBe("1:1");
    expect(out.svg).toContain('viewBox="0 0 64 64"');
  });
});

describe("Name only", () => {
  const site = 'export const SITE = {\n  name: "Sweet Layers",\n  logo: "/images/logo.svg?v=abc123abc123",\n  tagline: "Cakes",\n};\n';
  const app = "export function App() { return <SiteHeader logo={SITE.logo} name={SITE.name} />; }\n";
  const sandbox = (theme = ":root{}") =>
    ({
      readFile: vi.fn(async (path: string) =>
        path.endsWith("logo.svg") ? "old-logo" : path.endsWith("favicon.svg") ? "old-favicon" : path.endsWith("App.tsx") ? app : path.endsWith("theme.css") ? theme : site,
      ),
    }) as unknown as SiteSandbox;

  it("drops the logo line so the header shows the name as text, and gives the tab an initials favicon", async () => {
    const plan = await nameOnlyLogoPlan({ logo: "old-logo", favicon: "old-favicon", site, app }, "Sweet Layers")(sandbox());
    if ("reason" in plan) throw new Error(plan.reason);
    const byPath = new Map(plan.files.map((f) => [f.path, f.after]));
    expect(byPath.get("src/site.ts")).toBe('export const SITE = {\n  name: "Sweet Layers",\n  tagline: "Cakes",\n};\n');
    expect(byPath.get("public/favicon.svg")).toContain(">SL</text>");
    expect(byPath.has("public/images/logo.svg")).toBe(false);
  });

  it("colours the initials favicon with the theme being applied in the same change", async () => {
    const preset = THEME_PRESETS[0]!;
    const next = renderThemeCss({ ...preset, colors: { ...preset.colors, primary: "#123456" } });
    const plan = await nameOnlyLogoPlan({ logo: "old-logo", favicon: "old-favicon", site, app }, "Sweet Layers", { themeCss: next })(sandbox());
    if ("reason" in plan) throw new Error(plan.reason);
    expect(plan.files.find((f) => f.path === "public/favicon.svg")?.after).toContain('fill="#123456"');
  });

  it("refuses when the site changed since it was read", async () => {
    expect(await nameOnlyLogoPlan({ logo: "old-logo", favicon: "older", site, app }, "Sweet Layers")(sandbox())).toEqual({ reason: "changed" });
  });

  it("the starter's own src/site.ts round-trips: a logo added by Icon + name is removed by Name only", async () => {
    const { TEMPLATE_FILES } = await import("@/services/provisioning/templates/vite-react-zavi/template-files.generated");
    const starter = (TEMPLATE_FILES as Record<string, string>)["src/site.ts"]!;
    const withLogo = siteSourceWithLogo(starter, "/images/logo.svg?v=abc123abc123")!;
    expect(withLogo).toContain("logo:");
    expect(siteSourceWithoutLogo(withLogo)).toBe(starter);
    expect(siteSourceWithoutLogo(starter)).toBe(starter);
  });

  it("removing the logo line: none to remove leaves the file alone, a logo set some other way is refused", () => {
    const plain = 'export const SITE = {\n  name: "Sweet Layers",\n  tagline: "Cakes",\n};\n';
    expect(siteSourceWithoutLogo(plain)).toBe(plain);
    expect(siteSourceWithoutLogo('export const SITE = {\n  ...BASE,\n  name: "Sweet Layers",\n};\n')).toBeNull();
    expect(siteSourceWithoutLogo('export const SITE = {\n  name: "Sweet Layers",\n  logo: LOGO,\n};\n')).toBeNull();
    const partner = 'export const PARTNERS = [{\n  logo: "/partner.svg",\n}];\nexport const SITE = {\n  name: "Sweet Layers",\n  logo: "/images/logo.svg",\n};\n';
    expect(siteSourceWithoutLogo(partner)).toBeNull();
    const partnerOnly = 'export const PARTNERS = [{\n  logo: "/partner.svg",\n}];\nexport const SITE = {\n  name: "Sweet Layers",\n};\n';
    expect(siteSourceWithoutLogo(partnerOnly)).toBeNull();
    const partnerAfter = 'export const SITE = {\n  name: "Sweet Layers",\n};\nexport const PARTNERS = [{\n  logo: "/partner.svg",\n}];\n';
    expect(siteSourceWithoutLogo(partnerAfter)).toBeNull();
    expect(siteSourceWithoutLogo('export const OTHER = {\n  name: "x",\n  logo: "/a.svg",\n};\n')).toBeNull();
    const nested = 'export const SITE = {\n  name: "Acme",\n  partners: [\n    { logo: "/partner.svg" },\n  ],\n};\n';
    expect(siteSourceWithoutLogo(nested)).toBe(nested);
    const nestedLine = 'export const SITE = {\n  name: "Acme",\n  sponsor: {\n    logo: "/sponsor.svg",\n  },\n};\n';
    expect(siteSourceWithoutLogo(nestedLine)).toBeNull();
    const indentedClose = 'export const SITE = {\n  name: "Acme",\n  logo: "/images/logo.svg",\n  };\n';
    expect(siteSourceWithoutLogo("export const SITE = {\n  name: 'Acme',\n  logo: '/images/logo.svg',\n};\n")).toBe("export const SITE = {\n  name: 'Acme',\n};\n");
    const nestedFirst = 'const logo = "/site.svg";\nexport const SITE = {\n  partner: {\n    name: "Partner",\n    logo: "/partner.svg",\n  },\n  name: "Acme",\n  logo,\n};\n';
    expect(siteSourceWithoutLogo(nestedFirst)).toBeNull();
    const sameIndent = 'export const SITE = {\n  partner: {\n  name: "Partner",\n  logo: "/partner.svg",\n  },\n  name: "Acme",\n};\n';
    expect(siteSourceWithoutLogo(sameIndent)).toBeNull();
    expect(siteSourceWithoutLogo(indentedClose)).toBe('export const SITE = {\n  name: "Acme",\n  };\n');
  });
});

describe("a new build's logo goes through the designer again", () => {
  it("passes the founder's Logo answer to the designer and draws the designer's concept", async () => {
    const { prepareBuildLogo } = await import("../site-logo-generate");
    const design = vi.fn(async () => ({
      spec: { type: "mascot", style: "solid-silhouette", subject: "a fox reading a book", concept: "a fox curled around an open book", rationale: "The founder asked for a fox.", avoid: [], source: "founder" },
      ms: 5,
    }));
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="10"/></svg>';
    const d = { ...deps(svg), design } as unknown as Parameters<typeof prepareBuildLogo>[1];
    const out = await prepareBuildLogo(
      { tenant_id: "t", run_id: "r", site_name: "Paper Fox", idea: "A small bookshop with a reading cafe.\n\n- Logo: a fox reading a book" },
      d,
      () => undefined,
    );
    if ("reason" in out) throw new Error(out.reason);
    expect((design.mock.calls[0] as unknown as [{ direction: string }])[0].direction).toBe("a fox reading a book");
    const prompt = ((d.generate as ReturnType<typeof vi.fn>).mock.calls[0] as unknown as [string, { prompt: string }])[1].prompt;
    expect(prompt).toContain("a fox reading a book");
    expect(out.design?.type).toBe("mascot");
  });
});

describe("the name the site shows, read from src/site.ts however the rename quoted it", () => {
  it.each([
    ['export const SITE = { name: "Saffron Spoon" };', "Saffron Spoon"],
    ["export const SITE = { name: 'Spice Table', logo: \"/images/logo.svg\" };", "Spice Table"],
    ["export const SITE = { name: `Spice Table` };", "Spice Table"],
    ["export const SITE = { name: 'Rise \\'n Shine' };", "Rise 'n Shine"],
    ['export const SITE = { name: "Rise \\"n\\" Shine" };', 'Rise "n" Shine'],
    ["export const SITE = { name: 'Say \"hi\" Bakery' };", 'Say "hi" Bakery'],
  ])("%s", (source, name) => {
    expect(siteNameFrom(source)).toBe(name);
  });

  it("a template with a substitution cannot be read, so the stored name is used instead", () => {
    expect(siteNameFrom("export const SITE = { name: `${BRAND} Bakery` };")).toBe("");
    expect(siteNameFrom(null)).toBe("");
  });
});
