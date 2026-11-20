export type WireframeTokens = { cream: string; bone: string; ink: string; inkMuted: string; rule: string };

const TOKEN_VARS: Record<keyof WireframeTokens, string> = {
  cream: "--c-cream",
  bone: "--c-bone",
  ink: "--c-ink",
  inkMuted: "--c-ink-muted",
  rule: "--c-rule",
};

const TRIPLE = /^\d{1,3} \d{1,3} \d{1,3}$/;

const HUES = {
  mintDeep: "14 159 110",
  orange: "249 115 22",
  geo: "124 58 237",
  brand: "2 123 255",
  linkedin: "0 115 178",
  marigoldDeep: "224 168 0",
  coral: "255 107 107",
  rose: "225 29 72",
  teal: "13 148 136",
} as const;

const TEMPLATE_HUE: Record<string, string> = {
  "book-a-service": HUES.mintDeep,
  "menu-and-hours": HUES.orange,
  portfolio: HUES.geo,
  "product-launch": HUES.brand,
  "professional-services": HUES.linkedin,
  "classes-and-events": HUES.marigoldDeep,
  community: HUES.coral,
  salon: HUES.rose,
  restaurant: HUES.marigoldDeep,
  gym: HUES.orange,
  clinic: HUES.teal,
  agency: HUES.geo,
  shop: HUES.coral,
};

const HUE_LIST = Object.values(HUES);

export function templateHue(id: string): string {
  const known = TEMPLATE_HUE[id];
  if (known) return known;
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return HUE_LIST[h % HUE_LIST.length]!;
}

export function readWireframeTokens(root?: HTMLElement): WireframeTokens | null {
  if (typeof window === "undefined" || typeof getComputedStyle !== "function") return null;
  const style = getComputedStyle(root ?? document.documentElement);
  const out = {} as WireframeTokens;
  for (const key of Object.keys(TOKEN_VARS) as Array<keyof WireframeTokens>) {
    const value = style.getPropertyValue(TOKEN_VARS[key]).trim().replace(/\s+/g, " ");
    if (!TRIPLE.test(value)) return null;
    out[key] = value;
  }
  return out;
}

function mix(a: string, b: string, t: number): string {
  const x = a.split(" ").map(Number);
  const y = b.split(" ").map(Number);
  return x.map((v, i) => Math.round(v + (y[i]! - v) * t)).join(" ");
}

export function templateWireframeCss(id: string, tokens: WireframeTokens | null): string {
  if (!tokens) return "";
  const { cream, bone, ink, inkMuted, rule } = tokens;
  const hue = templateHue(id);
  const hero = mix(cream, hue, 0.14);
  const soft = mix(cream, hue, 0.06);
  const slot = mix(bone, hue, 0.1);
  const accent = mix(cream, hue, 0.22);
  const primary = mix(hue, ink, 0.25);
  const rgb = (t: string) => `rgb(${t})`;
  return [
    `:root{--background:${cream};--foreground:${ink};--card:${cream};--card-foreground:${ink};--muted:${soft};--muted-foreground:${inkMuted};--primary:${primary};--primary-foreground:${cream};--secondary:${cream};--secondary-foreground:${ink};--accent:${accent};--accent-foreground:${ink};--border:${rule};--inverse:${hero};--inverse-foreground:${ink};--shadow-sm:none;--shadow-md:none;--shadow-lg:none}`,
    `.surface-inverse{--background:${hero};--foreground:${ink};--card:${hero};--card-foreground:${ink};--muted:${soft};--muted-foreground:${inkMuted}}`,
    `.hero{background:${rgb(hero)}!important;color:${rgb(ink)}!important}`,
    `.hero h1{color:${rgb(ink)}!important}`,
    `.hero .subtitle{color:${rgb(inkMuted)}!important;opacity:1!important}`,
    `.hero .btn-primary,.cta .btn-primary{background:${rgb(primary)}!important;color:${rgb(cream)}!important}`,
    `.sec.tone-inverse{background:${rgb(hero)}!important}`,
    `.sec.tone-inverse h2,.sec.tone-inverse .num{color:${rgb(ink)}!important}`,
    `.image-slot{background:${rgb(slot)}!important;border-color:${rgb(rule)}!important;color:${rgb(inkMuted)}!important}`,
    `.cta{background:${rgb(accent)}!important;color:${rgb(ink)}!important}`,
  ].join("\n");
}
