
import { siteShownName } from "./label";

export const ZAVI_HEAD_DECLARATION_RE = /const ZAVI_HEAD = \{[^}\n]*\};/;

export const SITE_CARD_PATH = "/api/public/site-card";

const PALETTE = ["#1f6feb", "#0f766e", "#b45309", "#7c3aed", "#be123c", "#15803d", "#c2410c", "#0e7490"];

const escapeXml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function siteFaviconSvg(name: string): string {
  const initial = (name.match(/[A-Za-z0-9]/)?.[0] ?? "Z").toUpperCase();
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const fill = PALETTE[hash % PALETTE.length];
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
    `<rect width="64" height="64" rx="14" fill="${fill}"/>` +
    `<text x="32" y="43" text-anchor="middle" font-family="system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif" font-size="34" font-weight="700" fill="#ffffff">${escapeXml(initial)}</text>` +
    `</svg>\n`
  );
}

function headLiteral(head: Record<string, string>): string {
  return JSON.stringify(head, null, 0).replace(/[{}<>\u2028\u2029]/g, (c, offset: number, all: string) =>
    offset === 0 || offset === all.length - 1 ? c : `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export function siteCardUrl(webBase: string, name: string, hostname: string): string {
  const q = new URLSearchParams({ name, host: hostname });
  return `${webBase.replace(/\/+$/, "")}${SITE_CARD_PATH}?${q.toString()}`;
}

export const SITE_LOGO_PATH = "public/images/logo.svg";
export const SITE_LOGO_URL = "/images/logo.svg";
export const SITE_CONFIG_PATH = "src/site.ts";
const SITE_NAME_LINE = /(\n(\s*)name:\s*"(?:[^"\\\n]|\\.)*",\n)/;
const SITE_LOGO_LINE = /^(\s*logo:\s*)(?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')(\s*,?\s*(?:\/\/[^\n]*)?)$/m;
const SITE_LOGO_KEY_LINE = /^\s*logo\s*:/m;
const SITE_SPREAD_LINE = /^\s*\.\.\./m;

export function siteSourceWithLogo(source: string, logoUrl = SITE_LOGO_URL): string | null {
  if (SITE_SPREAD_LINE.test(source)) return null;
  if (SITE_LOGO_LINE.test(source)) {
    return source.replace(SITE_LOGO_LINE, (_match, lead: string, tail: string) => `${lead}${JSON.stringify(logoUrl)}${tail}`);
  }
  if (SITE_LOGO_KEY_LINE.test(source)) return null;
  if (!SITE_NAME_LINE.test(source)) return null;
  return source.replace(SITE_NAME_LINE, (_match, line: string, indent: string) => `${line}${indent}logo: ${JSON.stringify(logoUrl)},\n`);
}

export function siteSourceWithoutLogo(source: string): string | null {
  if (SITE_SPREAD_LINE.test(source)) return null;
  const start = /^export const SITE\b[^\n]*\{[ \t]*$/m.exec(source);
  const close = start ? /^[ \t]*\};/m.exec(source.slice(start.index)) : null;
  if (!start || !close) return null;
  const block = source.slice(start.index, start.index + close.index);
  const name = /^[^\n]*\{[ \t]*\n([ \t]*)name:\s*(?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')/.exec(block);
  if (!name) return null;
  if (/^[ \t]*logo[ \t]*[,}]/m.test(source)) return null;
  const keys = [...source.matchAll(/^([ \t]*)logo\s*:/gm)];
  if (keys.length === 0) return source;
  const key = keys[0]!;
  const inside = key.index! > start.index && key.index! < start.index + close.index;
  if (keys.length > 1 || !inside || key[1] !== name[1]) return null;
  if (!SITE_LOGO_LINE.test(source)) return null;
  return source.replace(new RegExp(`${SITE_LOGO_LINE.source}\\n?`, "m"), "");
}

export type SiteHeadInput = { label: string; name?: string | null; hostname: string; webBase: string; logoSvg?: string | null; faviconSvg?: string | null };

function headDeclaration(input: SiteHeadInput): string {
  const name = siteShownName(input);
  const head = {
    name,
    url: `https://${input.hostname}/`,
    image: /^https?:\/\//.test(input.webBase) ? siteCardUrl(input.webBase, name, input.hostname) : "",
  };
  return `const ZAVI_HEAD = ${headLiteral(head)};`;
}

export function retargetSiteHead(files: Readonly<Record<string, string>>, input: SiteHeadInput): Record<string, string> {
  const out: Record<string, string> = { ...files };
  const config = out["vite.config.ts"];
  if (!out["vite-zavi-head.ts"] || typeof config !== "string" || !ZAVI_HEAD_DECLARATION_RE.test(config)) return out;
  out["vite.config.ts"] = config.replace(ZAVI_HEAD_DECLARATION_RE, () => headDeclaration(input));
  return out;
}

export function starterShowsLogo(files: Readonly<Record<string, string>>): boolean {
  const probe = personalizeSiteStarter(files, { label: "logo-probe", hostname: "logo-probe.invalid", webBase: "", logoSvg: "<svg/>" });
  return probe[SITE_LOGO_PATH] === "<svg/>";
}

export function personalizeSiteStarter(
  files: Readonly<Record<string, string>>,
  input: SiteHeadInput,
): Record<string, string> {
  const out: Record<string, string> = { ...files };
  const config = out["vite.config.ts"];
  if (!out["vite-zavi-head.ts"] || typeof config !== "string" || !ZAVI_HEAD_DECLARATION_RE.test(config)) return out;
  const name = siteShownName(input);
  out["vite.config.ts"] = config.replace(ZAVI_HEAD_DECLARATION_RE, () => headDeclaration(input));
  if (typeof out["index.html"] === "string") {
    out["index.html"] = out["index.html"].replace(/<title>New site<\/title>/, () => `<title>${escapeXml(name)}</title>`);
  }
  if (typeof out["src/site.ts"] === "string") {
    out["src/site.ts"] = out["src/site.ts"].replace(/(\n\s*name:\s*)"New site"(,)/, (_m, lead: string, tail: string) => `${lead}${JSON.stringify(name)}${tail}`);
  }
  out["public/favicon.svg"] = siteFaviconSvg(name);
  const logo = typeof input.logoSvg === "string" && input.logoSvg.startsWith("<svg") ? input.logoSvg : null;
  const siteWithLogo = logo && typeof out[SITE_CONFIG_PATH] === "string" ? siteSourceWithLogo(out[SITE_CONFIG_PATH]) : null;
  if (logo && siteWithLogo) {
    out[SITE_LOGO_PATH] = logo;
    out["public/favicon.svg"] = typeof input.faviconSvg === "string" && input.faviconSvg.startsWith("<svg") ? input.faviconSvg : logo;
    out[SITE_CONFIG_PATH] = siteWithLogo;
  }
  return out;
}
