
export type ThemeColorKey = "primary" | "background" | "foreground" | "accent";

export type SiteThemeTokens = {
  name: string;
  colors: Record<ThemeColorKey, string>;
  fonts: { display: string; body: string };
  radius: string;
};

export type SiteThemeState = {
  theme: SiteThemeTokens | null;
  fonts: string[];
  radii: string[];
  logo_ai: boolean;
  logo_preview_free: boolean;
};

export type ThemeOp = {
  kind: "theme";
  colors?: Partial<Record<ThemeColorKey, string>>;
  fonts?: { display?: string; body?: string };
  radius?: string;
  logo?: { preview_id: string };
};

export type LogoPreview = { id: string; src: string; free: boolean };

export const THEME_COLORS: ReadonlyArray<{ key: ThemeColorKey; label: string }> = [
  { key: "primary", label: "Brand" },
  { key: "background", label: "Page" },
  { key: "foreground", label: "Text" },
  { key: "accent", label: "Accent" },
];

export const RADIUS_LABEL: Record<string, string> = {
  "0": "Square",
  "0.25rem": "Slight",
  "0.5rem": "Soft",
  "0.75rem": "Rounded",
  "1rem": "Round",
  "1.5rem": "Pill",
};

export const LOGO_MIN = 3;
export const LOGO_MAX = 400;
export const LOGO_IDEAS: ReadonlyArray<{ label: string; text: string }> = [
  { label: "Monogram", text: "A bold monogram of the initials" },
  { label: "Line icon", text: "A simple line icon that hints at what the site does" },
  { label: "Abstract mark", text: "An abstract geometric mark made from two overlapping shapes" },
];
export const LOGO_PLACEHOLDER = "A geometric hummingbird made from two flowing shapes";

export const SITE_DESIGN_SAVED = "Saved. It goes live when you publish.";
export const SITE_DESIGN_FAILED = "We couldn't save that change. Try again, or ask for it in the chat.";
export const THEME_UNAVAILABLE = "This site's colours and fonts can't be changed here. Ask for the change in the chat.";
const VIEWER_REFUSAL = "Viewers can't change the site. Ask a workspace owner, admin or member.";
const BUSY_CODES = new Set(["lease_held", "preview_starting", "build_active"]);

export function logoCostLine(freeNext: boolean, themeDirty: boolean): string {
  return `${freeNext ? "Your first logo for this site is free." : "Each new logo uses AI credits."}${
    themeDirty ? " Made in the colours on the Theme tab, including ones you haven't applied." : ""
  }`;
}

export function applyScope(themeDirty: boolean, logo: boolean): string | null {
  if (themeDirty && logo) return "Saves theme and logo";
  if (logo) return "Saves the logo";
  if (themeDirty) return "Saves the theme";
  return null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function siteAppId(siteId: string | null | undefined): string | null {
  const id = (siteId ?? "").trim().toLowerCase();
  return UUID.test(id) ? `site:${id}` : null;
}

function readTokens(raw: unknown): SiteThemeTokens | null {
  const t = raw as Partial<SiteThemeTokens> | null | undefined;
  const c = t?.colors as Partial<Record<ThemeColorKey, unknown>> | undefined;
  if (!t || !c || !t.fonts || typeof t.radius !== "string") return null;
  if (!THEME_COLORS.every(({ key }) => typeof c[key] === "string")) return null;
  if (typeof t.fonts.display !== "string" || typeof t.fonts.body !== "string") return null;
  return {
    name: typeof t.name === "string" ? t.name : "",
    colors: { primary: c.primary as string, background: c.background as string, foreground: c.foreground as string, accent: c.accent as string },
    fonts: { display: t.fonts.display, body: t.fonts.body },
    radius: t.radius,
  };
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function readSiteTheme(body: unknown): SiteThemeState {
  const b = (body ?? {}) as Record<string, unknown>;
  const logoAi = b.logo_ai === true;
  return {
    theme: readTokens(b.theme),
    fonts: strings(b.fonts),
    radii: strings(b.radii),
    logo_ai: logoAi,
    logo_preview_free: logoAi && b.logo_preview_free === true,
  };
}

export function readLogoPreview(body: unknown): LogoPreview | null {
  const p = (body as { preview?: Record<string, unknown> } | null)?.preview;
  if (!p || typeof p.id !== "string" || typeof p.src !== "string" || !p.src.startsWith("data:image/svg+xml")) return null;
  return { id: p.id, src: p.src, free: p.free === true };
}

const HEX6 = /^#[0-9a-f]{6}$/i;

export function readHex(input: string): string | null {
  let v = input.trim();
  if (!v.startsWith("#")) v = `#${v}`;
  if (/^#[0-9a-f]{3}$/i.test(v)) v = `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  return HEX6.test(v) ? v.toLowerCase() : null;
}

export function themeChanges(current: SiteThemeTokens | null, draft: SiteThemeTokens | null): ThemeOp | null {
  if (!current || !draft) return null;
  const colors: Partial<Record<ThemeColorKey, string>> = {};
  for (const { key } of THEME_COLORS) {
    if (draft.colors[key].toLowerCase() !== current.colors[key].toLowerCase()) colors[key] = draft.colors[key];
  }
  const fonts: { display?: string; body?: string } = {};
  if (draft.fonts.display !== current.fonts.display) fonts.display = draft.fonts.display;
  if (draft.fonts.body !== current.fonts.body) fonts.body = draft.fonts.body;
  const op: ThemeOp = {
    kind: "theme",
    ...(Object.keys(colors).length ? { colors } : {}),
    ...(Object.keys(fonts).length ? { fonts } : {}),
    ...(draft.radius !== current.radius ? { radius: draft.radius } : {}),
  };
  return Object.keys(op).length > 1 ? op : null;
}

export function applyOp(changes: ThemeOp | null, logo: LogoPreview | null): ThemeOp | null {
  if (!changes && !logo) return null;
  return { ...(changes ?? { kind: "theme" }), ...(logo ? { logo: { preview_id: logo.id } } : {}) };
}

export function cleanLogoDescription(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function logoReady(text: string): boolean {
  const n = cleanLogoDescription(text).length;
  return n >= LOGO_MIN && n <= LOGO_MAX;
}

export function withCurrent(current: string, list: string[]): string[] {
  return [...new Set([current, ...list])];
}

export type ThemeNote = { tone: "ok" | "busy" | "error"; text: string };

export function refusalNote(err: unknown): ThemeNote {
  const e = (err ?? {}) as { status?: number; code?: string; message?: string };
  const code = typeof e.code === "string" ? e.code : "";
  if (e.status === 403 && code === "forbidden") return { tone: "error", text: VIEWER_REFUSAL };
  const text = typeof e.message === "string" && e.message.trim() ? e.message : SITE_DESIGN_FAILED;
  return { tone: BUSY_CODES.has(code) ? "busy" : "error", text };
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64Bytes(s: string): number[] | null {
  const clean = s.replace(/\s+/g, "").replace(/=+$/, "");
  const out: number[] = [];
  let buf = 0;
  let bits = 0;
  for (const ch of clean) {
    const v = B64.indexOf(ch);
    if (v < 0) return null;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 0xff);
    }
  }
  return out;
}

export function svgFromDataUrl(src: string): string | null {
  const m = /^data:image\/svg\+xml(;[^,]*)?,(.*)$/s.exec(src);
  if (!m) return null;
  try {
    if ((m[1] ?? "").includes(";base64")) {
      const bytes = base64Bytes(m[2]);
      if (!bytes) return null;
      return decodeURIComponent(bytes.map((b) => `%${b.toString(16).padStart(2, "0")}`).join(""));
    }
    return decodeURIComponent(m[2]);
  } catch {
    return null;
  }
}
