
export const SITE_CARD_NAME_MAX = 60;
const HOST_RE = /^(?=.{4,120}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export type SiteCard = { name: string; host: string | null };

export function siteCardParams(params: URLSearchParams): SiteCard {
  const name = (params.get("name") ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const shown = name.length > SITE_CARD_NAME_MAX ? `${name.slice(0, SITE_CARD_NAME_MAX - 1).trimEnd()}…` : name;
  const host = (params.get("host") ?? "").trim().toLowerCase();
  return { name: shown || "Website", host: HOST_RE.test(host) ? host : null };
}

const PALETTE = ["#1f6feb", "#0f766e", "#b45309", "#7c3aed", "#be123c", "#15803d", "#c2410c", "#0e7490"];

export function siteCardColour(name: string): string {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}
