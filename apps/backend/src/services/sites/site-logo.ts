import { LOGO_ICONS, LOGO_ICON_NAMES, type LogoIconName } from "./logo-icons";
import { decodeXmlEntities } from "@/services/onboarding/enrichment/sanitize";
import { SITE_LOGO_URL } from "./site-head";

export { LOGO_ICON_NAMES };

export type LogoShape = "rounded" | "circle";
export type LogoRecipe = {
  icon: LogoIconName | null;
  shape: LogoShape;
  letters?: string;
};

const ICONS: ReadonlySet<string> = new Set(LOGO_ICON_NAMES);
const HEX = /^#[0-9a-f]{6}$/i;
const LETTERS = /^[A-Z0-9]{1,2}$/;

export function logoLetters(name: string | null | undefined): string {
  const words = String(name ?? "").split(/[^A-Za-z0-9]+/).filter(Boolean);
  return words.slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "Z";
}

export function parseLogoRecipe(raw: unknown): LogoRecipe | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { icon?: unknown; shape?: unknown; letters?: unknown };
  const icon = typeof r.icon === "string" ? r.icon.trim().toLowerCase() : null;
  return {
    icon: icon && ICONS.has(icon) ? (icon as LogoIconName) : null,
    shape: r.shape === "circle" ? "circle" : "rounded",
    ...(typeof r.letters === "string" && LETTERS.test(r.letters) ? { letters: r.letters } : {}),
  };
}

export const DEFAULT_LOGO_RECIPE: LogoRecipe = { icon: null, shape: "rounded" };

function attr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export type LogoColors = { primary: string; primaryForeground: string };
export type SiteLogoFiles = { logo: string; favicon: string };

function renderLettermark(letters: string, shape: LogoShape, primary: string, onPrimary: string): SiteLogoFiles {
  const tile = shape === "circle" ? `<circle cx="32" cy="32" r="32" fill="${primary}"/>` : `<rect width="64" height="64" rx="14" fill="${primary}"/>`;
  const size = letters.length > 1 ? 28 : 34;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" data-zavi-logo="letters">${tile}` +
    `<text x="32" y="32" dy="0.35em" text-anchor="middle" font-family="system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif" font-size="${size}" font-weight="700" fill="${onPrimary}">${attr(letters)}</text></svg>\n`;
  return { logo: svg, favicon: svg };
}

export function renderSiteLogo(recipe: LogoRecipe, colors: LogoColors): SiteLogoFiles | null {
  const primary = HEX.test(colors.primary) ? colors.primary : "#111827";
  const onPrimary = HEX.test(colors.primaryForeground) ? colors.primaryForeground : "#ffffff";
  if (!recipe.icon || !ICONS.has(recipe.icon)) {
    return recipe.letters && LETTERS.test(recipe.letters) ? renderLettermark(recipe.letters, recipe.shape, primary, onPrimary) : null;
  }
  const nodes = LOGO_ICONS[recipe.icon]
    .map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${attr(v)}"`).join(" ")}/>`)
    .join("");
  const stroke = (color: string, transform: string, width: string) =>
    `<g transform="${transform}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round">${nodes}</g>`;
  const open = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" data-zavi-logo="mark">`;
  const tile =
    recipe.shape === "circle"
      ? `<circle cx="32" cy="32" r="32" fill="${primary}"/>`
      : `<rect width="64" height="64" rx="14" fill="${primary}"/>`;
  return {
    logo: `${open}${stroke(primary, "translate(8 8) scale(2)", "2.25")}</svg>\n`,
    favicon: `${open}${tile}${stroke(onPrimary, "translate(14 14) scale(1.5)", "2")}</svg>\n`,
  };
}

const LOGO_LINE = /(?:^|\n)- Logo: ([^\n]{1,300})/g;

export function logoIntent(rawIdea: string): "none" | "describe" | "yes" | null {
  const idea = decodeXmlEntities(String(rawIdea ?? ""));
  let found: "none" | "describe" | "yes" | null = null;
  for (const m of idea.matchAll(LOGO_LINE)) {
    const answer = m[1]!.trim();
    found = /^no logo\b/i.test(answer) ? "none" : /^make a logo mark showing\b/i.test(answer) ? "describe" : "yes";
  }
  return found;
}

export type SiteLogoSource = "mark" | "uploaded" | "none";

export function siteLogoSource(input: { idea: string; hasUploaded: boolean }): SiteLogoSource {
  const intent = logoIntent(input.idea);
  if (intent === "none") return "none";
  if (intent === "describe") return "mark";
  return input.hasUploaded ? "uploaded" : "mark";
}

type BriefWithLogo = { logo?: LogoRecipe; brand?: { voice?: string; logo?: string; colors?: "company" } };

export type SeededLogo<B> = { svg: string | null; favicon: string | null; brief: B };

export function seedSiteLogo<B extends BriefWithLogo>(input: {
  brief: B;
  stored: boolean;
  idea: string;
  uploadedSvg: string | null;
  canShowLogo: boolean;
  colors: LogoColors;
}): SeededLogo<B> {
  const { brief } = input;
  const rest = { ...brief };
  delete rest.logo;
  const noLogo = (): SeededLogo<B> => {
    if (!brief.brand) return { svg: null, favicon: null, brief: rest };
    const brand = { ...brief.brand };
    delete brand.logo;
    return { svg: null, favicon: null, brief: { ...rest, brand } };
  };
  if (!input.canShowLogo) return noLogo();
  if (input.stored) {
    const recipe = parseLogoRecipe(brief.logo);
    const mark = recipe ? renderSiteLogo(recipe, input.colors) : null;
    if (mark) return { svg: mark.logo, favicon: mark.favicon, brief };
    if (brief.brand?.logo === SITE_LOGO_URL && input.uploadedSvg) return { svg: input.uploadedSvg, favicon: input.uploadedSvg, brief };
    return noLogo();
  }
  const source = siteLogoSource({ idea: input.idea, hasUploaded: !!input.uploadedSvg });
  if (source === "mark") {
    const recipe = parseLogoRecipe(brief.logo) ?? DEFAULT_LOGO_RECIPE;
    const mark = renderSiteLogo(recipe, input.colors);
    if (!mark) return noLogo();
    return {
      svg: mark.logo,
      favicon: mark.favicon,
      brief: { ...rest, logo: recipe, brand: { ...brief.brand, logo: SITE_LOGO_URL } },
    };
  }
  if (source === "uploaded") return { svg: input.uploadedSvg, favicon: input.uploadedSvg, brief: rest };
  return noLogo();
}
