import { z } from "zod";
import { LOGO_ICON_NAMES, parseLogoRecipe, type LogoRecipe } from "./site-logo";
import { createMessageWithFailover, hasAnthropicAuth, cachedSystemBlock } from "@/services/anthropic";
import { MODELS } from "@/services/llm/models";
import { decodeXmlEntities } from "@/services/onboarding/enrichment/sanitize";
import { DEFAULT_THEME_PRESET, FONT_LIBRARY, THEME_CSS_PATH, THEME_PRESETS, describeThemePresets, getThemePreset, resolveTheme } from "@/services/provisioning/templates/vite-react-zavi/theme-presets";

const LIBRARY_FONTS: Record<string, { weights: string; kind: "sans" | "serif" }> = Object.fromEntries(
  Object.entries(FONT_LIBRARY).map(([family, info]) => [
    family,
    { weights: info.weights.filter((w) => w >= 400 && w <= 800).join(";"), kind: info.category === "serif" ? "serif" : "sans" },
  ]),
);

export const BRIEF_FONTS: Readonly<Record<string, { weights: string; kind: "sans" | "serif" }>> = {
  ...LIBRARY_FONTS,
  Inter: { weights: "400;600;700", kind: "sans" },
  Manrope: { weights: "400;600;700", kind: "sans" },
  "DM Sans": { weights: "400;600;700", kind: "sans" },
  "Work Sans": { weights: "400;600;700", kind: "sans" },
  Nunito: { weights: "400;600;700", kind: "sans" },
  Poppins: { weights: "400;600;700", kind: "sans" },
  Outfit: { weights: "400;600;700", kind: "sans" },
  "Space Grotesk": { weights: "400;600;700", kind: "sans" },
  Rubik: { weights: "400;600;700", kind: "sans" },
  Archivo: { weights: "400;600;700", kind: "sans" },
  "IBM Plex Sans": { weights: "400;600;700", kind: "sans" },
  "Josefin Sans": { weights: "400;600;700", kind: "sans" },
  "Bricolage Grotesque": { weights: "400;600;700", kind: "sans" },
  Lato: { weights: "400;700", kind: "sans" },
  "Playfair Display": { weights: "400;600;700", kind: "serif" },
  Fraunces: { weights: "400;600;700", kind: "serif" },
  Lora: { weights: "400;600;700", kind: "serif" },
  Merriweather: { weights: "400;700", kind: "serif" },
  "DM Serif Display": { weights: "400", kind: "serif" },
  "Cormorant Garamond": { weights: "400;600;700", kind: "serif" },
  "Libre Baskerville": { weights: "400;700", kind: "serif" },
  "IBM Plex Serif": { weights: "400;600;700", kind: "serif" },
};

export type BriefFontPair = { heading: string; body: string; suits: readonly string[] };

export const BRIEF_FONT_PAIRS: readonly BriefFontPair[] = Object.freeze([
  { heading: "Fraunces", body: "Figtree", suits: ["cafe", "bakery", "restaurant", "coffee", "shop", "food"] },
  { heading: "Instrument Serif", body: "Inter", suits: ["studio", "agency", "portfolio", "architect", "photographer", "boutique"] },
  { heading: "Bricolage Grotesque", body: "DM Sans", suits: ["startup", "app", "kids", "events", "fitness", "gym"] },
  { heading: "Space Grotesk", body: "Work Sans", suits: ["software", "tech", "gaming", "auto", "repair", "detailing"] },
  { heading: "Playfair Display", body: "Source Sans 3", suits: ["law", "accounting", "finance", "real estate", "insurance", "consultant"] },
  { heading: "Cormorant Garamond", body: "Manrope", suits: ["salon", "spa", "jewellery", "wedding", "interior", "beauty"] },
  { heading: "DM Serif Display", body: "Outfit", suits: ["dessert", "party", "florist", "pet", "travel", "ice cream"] },
  { heading: "Plus Jakarta Sans", body: "Lora", suits: ["clinic", "dentist", "therapy", "wellness", "yoga", "health"] },
] satisfies BriefFontPair[]);

const PLAIN_HEADINGS: ReadonlySet<string> = new Set([
  "Inter",
  "DM Sans",
  "Lato",
  "Work Sans",
  "Nunito",
  "Rubik",
  "IBM Plex Sans",
  "Source Sans 3",
  "Manrope",
  "Poppins",
  "Figtree",
]);

function pairScore(pair: BriefFontPair, text: string): number {
  return pair.suits.reduce((n, word) => (new RegExp(`\\b${word}`, "i").test(text) ? n + 1 : n), 0);
}

export function fontPairForIdea(idea: string): BriefFontPair {
  const text = decodeXmlEntities(String(idea ?? ""));
  let best = BRIEF_FONT_PAIRS[0]!;
  let top = -1;
  for (const pair of BRIEF_FONT_PAIRS) {
    const score = pairScore(pair, text);
    if (score > top) {
      best = pair;
      top = score;
    }
  }
  return best;
}

function ideaNamesFont(idea: string, fonts: { heading: string; body: string }): boolean {
  const text = decodeXmlEntities(String(idea ?? "")).toLowerCase();
  return text.includes(fonts.heading.toLowerCase()) || text.includes(fonts.body.toLowerCase());
}

export function distinctiveFonts(fonts: { heading: string; body: string }, idea: string): { heading: string; body: string } {
  if (!PLAIN_HEADINGS.has(fonts.heading) || ideaNamesFont(idea, fonts)) return fonts;
  const pair = fontPairForIdea(idea);
  return { heading: pair.heading, body: pair.body };
}

export const BRIEF_COLOR_TOKENS = [
  "background",
  "foreground",
  "muted",
  "muted-foreground",
  "primary",
  "primary-foreground",
  "border",
] as const;
export type BriefColorToken = (typeof BRIEF_COLOR_TOKENS)[number];

export const PLAN_SECTION_VARIANTS = {
  Hero: ["centered", "split", "image", "editorial", "minimal"],
  Features: ["cards", "icons", "alternating", "split"],
  Testimonials: ["cards", "quote"],
  Gallery: ["grid", "masonry", "feature"],
  CTA: ["banner", "split"],
  FAQ: [],
  Pricing: [],
  Menu: [],
  HoursLocation: [],
  Stats: [],
  Contact: [],
} as const satisfies Record<string, readonly string[]>;
export type PlanComponent = keyof typeof PLAN_SECTION_VARIANTS;
export const PLAN_TONES = ["default", "muted", "inverse"] as const;
export type PlanTone = (typeof PLAN_TONES)[number];
export const PLAN_IMAGE_ROLES = ["hero", "service", "product", "people", "gallery", "supporting"] as const;
export type PlanImageRole = (typeof PLAN_IMAGE_ROLES)[number];
export const PLAN_IMAGE_ASPECTS = ["16:9", "4:5", "1:1"] as const;
export type PlanImageAspect = (typeof PLAN_IMAGE_ASPECTS)[number];
export const PLAN_IMAGE_PLACEMENTS = ["left", "right", "center", "full"] as const;
export type PlanImagePlacement = (typeof PLAN_IMAGE_PLACEMENTS)[number];
export const PLAN_MAX_IMAGES = 4;
export const PLAN_IMAGE_SUBJECT_MAX = 60;
export type PlanFocal = { x: number; y: number };
export type SitePlanImage = {
  subject: string;
  role?: PlanImageRole;
  aspect?: PlanImageAspect;
  placement?: PlanImagePlacement;
  overlay?: boolean;
  focal?: PlanFocal;
};
export type SitePlanSection = {
  name: string;
  headline: string;
  component?: PlanComponent;
  variant?: string;
  tone?: PlanTone;
  image?: SitePlanImage;
};
export type SitePlanPage = { path: string; title: string; sections: SitePlanSection[] };
export type SitePlan = { tone: string; primary_action: { label: string; steps: string }; pages: SitePlanPage[] };

export const BRIEF_LAYOUTS = {
  split:
    "a two-column hero (headline, one line and the main button on one side, a large photo on the other), then sections in alternating photo/text rows, a short how-it-works strip and a closing call to action",
  centered:
    "a full-width hero photo or colour band with the headline and button centred over it, then symmetric sections: a centred intro, a 2-3 column offer, a centred closing band",
  editorial:
    "a large expressive headline with a small kicker above it, asymmetric columns, pull quotes or big numbers, and long-form sections with generous white space, like a magazine spread",
  bold:
    "oversized type and high-contrast full-bleed colour blocks, a bold hero statement, a schedule or offer shown as big tiles, strong section dividers",
  minimal:
    "type-led and quiet: a short statement hero, then the work itself (a large image grid or list) with few words and lots of space",
} as const;
export type BriefLayout = keyof typeof BRIEF_LAYOUTS;

export function isBriefLayout(v: unknown): v is BriefLayout {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(BRIEF_LAYOUTS, v);
}

export type BriefLook = {
  base: string;
  layout: BriefLayout;
  alternates: string[];
};

export type BriefImagery = { subjects: string[]; style: string };

export type BriefBrand = { voice?: string; logo?: string; colors?: "company" };

export type DesignBrief = {
  industry: string;
  mood: string;
  mode: "light" | "dark";
  colors: Record<BriefColorToken, string>;
  fonts: { heading: string; body: string };
  plan?: SitePlan;
  earthy_replaced?: BriefColorToken[];
  audience?: string;
  positioning?: string;
  facts?: string[];
  imagery?: BriefImagery;
  look?: BriefLook;
  direction_given?: string;
  look_given?: "idea" | "references" | "template";
  template?: { id: string; v: number };
  brand?: BriefBrand;
  logo?: LogoRecipe;
  source?: "model" | "fallback";
};

export const BRIEF_MAX_FACTS = 8;
export const BRIEF_MAX_IMAGE_SUBJECTS = 5;

const PRESET_NAMES: ReadonlySet<string> = new Set(THEME_PRESETS.map((p) => p.name));

function briefList(raw: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const text = typeof item === "string" ? cleanLabel(item, maxLen) : "";
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

type BriefExtras = Pick<DesignBrief, "audience" | "positioning" | "facts" | "imagery" | "look" | "direction_given" | "look_given" | "logo">;

function squash(text: string): string {
  return text.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, " ").trim();
}

function directionGiven(raw: unknown, idea: string | undefined): string | undefined {
  const v = raw as { given?: unknown; quote?: unknown } | null | undefined;
  if (!v || typeof v !== "object" || v.given !== true || typeof v.quote !== "string" || typeof idea !== "string") return undefined;
  const quote = v.quote.replace(/\s+/g, " ").trim();
  if (quote.length < 3 || quote.length > 160) return undefined;
  return squash(idea).includes(squash(quote)) ? quote : undefined;
}

function factWords(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .replace(/['\u2019]/g, "")
        .split(/[^a-z0-9$]+/)
        .filter((w) => w.length >= 3)
        .map((w) => (w.length > 4 ? w.replace(/(ing|es|ed|s)$/, "") : w)),
    ),
  ];
}

export function factInIdea(fact: string, idea: string): boolean {
  const words = factWords(fact);
  if (words.length === 0) return false;
  const have = new Set(factWords(idea));
  return words.filter((w) => have.has(w)).length >= Math.ceil(words.length * 0.6);
}

export function parseBriefExtras(raw: unknown, idea?: string): BriefExtras {
  const j = (raw && typeof raw === "object" ? raw : {}) as {
    audience?: unknown;
    positioning?: unknown;
    facts?: unknown;
    imagery?: unknown;
    look?: unknown;
    visual_intent?: unknown;
    logo?: unknown;
  };
  const out: BriefExtras = {};
  const given = directionGiven(j.visual_intent, idea);
  if (given) {
    out.direction_given = given;
    out.look_given = "idea";
  }
  const logo = parseLogoRecipe(j.logo);
  if (logo) out.logo = { icon: logo.icon, shape: logo.shape };
  const audience = typeof j.audience === "string" ? cleanLabel(j.audience, 160) : "";
  if (audience) out.audience = audience;
  const positioning = typeof j.positioning === "string" ? cleanLabel(j.positioning, 200) : "";
  if (positioning && (typeof idea !== "string" || !isSocialProof(positioning) || factInIdea(positioning, idea))) out.positioning = positioning;
  const facts = briefList(j.facts, BRIEF_MAX_FACTS, 160).filter((f) => typeof idea !== "string" || factInIdea(f, idea));
  if (facts.length) out.facts = facts;
  const img = j.imagery as { subjects?: unknown; style?: unknown } | null | undefined;
  if (img && typeof img === "object" && Array.isArray(img.subjects)) {
    out.imagery = {
      subjects: briefList(img.subjects, BRIEF_MAX_IMAGE_SUBJECTS, 160),
      style: typeof img.style === "string" ? cleanLabel(img.style, 160) : "",
    };
  }
  const look = j.look as { base?: unknown; layout?: unknown; alternates?: unknown } | null | undefined;
  if (look && typeof look === "object") {
    const base = typeof look.base === "string" ? look.base.trim().toLowerCase() : "";
    const layout = typeof look.layout === "string" ? look.layout.trim().toLowerCase() : "";
    if (PRESET_NAMES.has(base)) {
      const alternates = briefList(look.alternates, 6, 32)
        .map((a) => a.toLowerCase())
        .filter((a) => PRESET_NAMES.has(a) && a !== base)
        .slice(0, 2);
      out.look = { base, layout: isBriefLayout(layout) ? layout : "split", alternates };
    }
  }
  return out;
}

export const PLAN_MAX_PAGES = 3;
export const PLAN_MAX_SECTIONS = 6;
const PLAN_PATH = /^\/[a-z0-9-]{0,40}$/;

function planText(raw: unknown, max: number): string {
  return typeof raw === "string" ? cleanLabel(raw, max) : "";
}

function oneOf<T extends string>(raw: unknown, allowed: readonly T[]): T | undefined {
  if (typeof raw !== "string") return undefined;
  const want = raw.trim().toLowerCase();
  return allowed.find((a) => a.toLowerCase() === want);
}

export function clampFocal(raw: unknown): PlanFocal | undefined {
  const f = raw as { x?: unknown; y?: unknown } | null;
  if (!f || typeof f !== "object" || typeof f.x !== "number" || typeof f.y !== "number") return undefined;
  if (!Number.isFinite(f.x) || !Number.isFinite(f.y)) return undefined;
  const pct = (n: number) => Math.min(100, Math.max(0, Math.round(n)));
  return { x: pct(f.x), y: pct(f.y) };
}

export function parsePlanImage(raw: unknown): SitePlanImage | undefined {
  const img = raw as { subject?: unknown; role?: unknown; aspect?: unknown; placement?: unknown; overlay?: unknown; focal?: unknown } | null;
  if (!img || typeof img !== "object") return undefined;
  const subject = planText(img.subject, PLAN_IMAGE_SUBJECT_MAX);
  if (!subject) return undefined;
  const role = oneOf(img.role, PLAN_IMAGE_ROLES);
  const aspect = oneOf(img.aspect, PLAN_IMAGE_ASPECTS);
  const placement = oneOf(img.placement, PLAN_IMAGE_PLACEMENTS);
  const focal = clampFocal(img.focal);
  return {
    subject,
    ...(role ? { role } : {}),
    ...(aspect ? { aspect } : {}),
    ...(placement ? { placement } : {}),
    ...(typeof img.overlay === "boolean" ? { overlay: img.overlay } : {}),
    ...(focal ? { focal } : {}),
  };
}

function parsePlanSection(raw: unknown): SitePlanSection {
  const sec = raw as { name?: unknown; headline?: unknown; component?: unknown; variant?: unknown; tone?: unknown; image?: unknown } | null;
  const out: SitePlanSection = { name: planText(sec?.name, 40), headline: planText(sec?.headline, 120) };
  const component = oneOf(sec?.component, Object.keys(PLAN_SECTION_VARIANTS) as PlanComponent[]);
  if (component) {
    out.component = component;
    const variant = oneOf(sec?.variant, PLAN_SECTION_VARIANTS[component] as readonly string[]);
    if (variant) out.variant = variant;
  }
  const tone = component === "Hero" ? undefined : oneOf(sec?.tone, PLAN_TONES);
  if (tone) out.tone = tone;
  const image = parsePlanImage(sec?.image);
  if (image) out.image = image;
  return out;
}

const SOCIAL_PROOF =
  /\b(?:trusted by|loved by|rated|reviews|testimonials?|five[- ]star|5[- ]star|what (?:our )?(?:customers|clients|families|patients) say)\b|★|\b\d[\d,]*\+?\s*(?:happy\s+|satisfied\s+)?(?:customers|clients|families|homes|households|users|students|patients|projects|jobs|reviews|years?)\b|\b(?:years|decades) of (?:experience|service)\b/i;

export function isSocialProof(text: string): boolean {
  return SOCIAL_PROOF.test(text);
}

const HERO_WITHOUT_PROOF = "What we do and who it is for";

function proofInvented(sec: SitePlanSection, idea: string): boolean {
  if (sec.component === "Testimonials" || sec.component === "Stats") return !isSocialProof(idea);
  return sec.component !== "Hero" && headlineProofInvented(sec, idea);
}

function headlineProofInvented(sec: SitePlanSection, idea: string): boolean {
  return isSocialProof(sec.headline) && !factInIdea(sec.headline, idea);
}

export function parseSitePlan(raw: unknown, idea?: string): SitePlan | null {
  const p = raw as { tone?: unknown; primary_action?: { label?: unknown; steps?: unknown }; pages?: unknown } | null;
  if (!p || typeof p !== "object" || !Array.isArray(p.pages)) return null;
  const seen = new Set<string>();
  const pages: SitePlanPage[] = [];
  for (const rawPage of p.pages) {
    const pg = rawPage as { path?: unknown; title?: unknown; sections?: unknown } | null;
    const path = typeof pg?.path === "string" ? pg.path.trim().toLowerCase() : "";
    const title = planText(pg?.title, 40);
    if (!PLAN_PATH.test(path) || seen.has(path) || !title || !Array.isArray(pg?.sections)) continue;
    const sections = (pg.sections as unknown[])
      .map(parsePlanSection)
      .filter((x) => x.name && x.headline)
      .filter((x) => typeof idea !== "string" || !proofInvented(x, idea))
      .map((x) => (typeof idea === "string" && x.component === "Hero" && headlineProofInvented(x, idea) ? { ...x, headline: HERO_WITHOUT_PROOF } : x))
      .slice(0, PLAN_MAX_SECTIONS);
    if (sections.length === 0) continue;
    seen.add(path);
    pages.push({ path, title, sections });
  }
  const home = pages.find((x) => x.path === "/");
  let images = 0;
  for (const pg of pages) {
    for (const sec of pg.sections) {
      if (!sec.image) continue;
      if (pg === home && images < PLAN_MAX_IMAGES) images += 1;
      else delete sec.image;
    }
  }
  const label = planText(p.primary_action?.label, 60);
  const steps = planText(p.primary_action?.steps, 200);
  if (!home || !label || !steps) return null;
  return {
    tone: planText(p.tone, 60) || "friendly and clear",
    primary_action: { label, steps },
    pages: [home, ...pages.filter((x) => x !== home)].slice(0, PLAN_MAX_PAGES),
  };
}

const HEX = /^#[0-9a-fA-F]{6}$/;

const BriefSchema = z.object({
  industry: z.string(),
  mood: z.string(),
  mode: z.enum(["light", "dark"]),
  colors: z.object(Object.fromEntries(BRIEF_COLOR_TOKENS.map((k) => [k, z.string().regex(HEX)])) as Record<BriefColorToken, z.ZodString>),
  fonts: z.object({ heading: z.string(), body: z.string() }),
});

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function mix(a: string, b: string, t: number): string {
  const [x, y] = [rgb(a), rgb(b)];
  return toHex([0, 1, 2].map((i) => x[i] * (1 - t) + y[i] * t) as [number, number, number]);
}

export const STARTER_COLORS: Readonly<Record<BriefColorToken, string>> = (() => {
  const t = resolveTheme(getThemePreset(DEFAULT_THEME_PRESET)!);
  return {
    background: t.background,
    foreground: t.foreground,
    muted: t.muted,
    "muted-foreground": t.mutedForeground,
    primary: t.primary,
    "primary-foreground": t.primaryForeground,
    border: t.border,
  };
})();

const DARK_NEUTRAL: Readonly<Record<BriefColorToken, string>> = {
  background: "#0b1120",
  foreground: "#f8fafc",
  muted: "#1e293b",
  "muted-foreground": "#94a3b8",
  primary: "#3b82f6",
  "primary-foreground": "#ffffff",
  border: "#334155",
};

export function isEarthy(hex: string): boolean {
  const [r, g, b] = rgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  if (d === 0) return false;
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = 60 * (max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4);
  return h >= 10 && h <= 115 && s >= 0.08 && s <= 0.65 && l >= 0.08 && l <= 0.72;
}

const EARTHY_IDEA =
  /\b(coffee|caf[eé]s?|espresso|roast(?:er|ery|ers)?|tea|chai|chocolate|cocoa|mocha|bakery|bakehouse|bread|wood\w*|carpent\w*|furniture|timber|lumber|joinery|farm\w*|ranch|barn|orchard|vineyards?|winery|wine|garden\w*|landscap\w*|nursery|plants?|organic|compost|soil|leather|pottery|potter|ceramics?|clay|outdoor|camping|hiking|safari|cabin|rustic|earth\w*|natural (?:tones|colou?rs)|olive|brown|beige|taupe|khaki|sage|tan|terracotta|antiques?|brewery|whiske?y|bourbon|harvest|equestrian|horses?|mushrooms?|forest|herbs?|herbal)\b/i;

export function earthyIdea(idea: string): boolean {
  const text = decodeXmlEntities(String(idea ?? ""));
  return EARTHY_IDEA.test(text) || /#[0-9a-f]{3}(?:[0-9a-f]{3})?\b/i.test(text);
}

const INK = "#111827";
const PAPER = "#ffffff";

function readableOn(bg: string): string {
  const best = contrast(INK, bg) >= contrast(PAPER, bg) ? INK : PAPER;
  return contrast(best, bg) >= 4.5 ? best : "#000000";
}

export function repairBriefContrast(c: Record<BriefColorToken, string>): void {
  if (contrast(c.foreground, c.background) < 4.5) c.foreground = readableOn(c.background);
  if (contrast(c["primary-foreground"], c.primary) < 4.5) c["primary-foreground"] = readableOn(c.primary);
  if (contrast(c["muted-foreground"], c.background) < 4.5) c["muted-foreground"] = mix(c.foreground, c.background, 0.3);
  if (contrast(c.foreground, c.muted) < 4.5) c.muted = mix(c.background, c.foreground, 0.06);
  if (contrast(c.foreground, c.muted) < 4.5) c.muted = c.background;
  if (contrast(c["muted-foreground"], c.background) < 4.5 || contrast(c["muted-foreground"], c.muted) < 4.5) {
    const original = c["muted-foreground"];
    for (let step = 1; step <= 20; step++) {
      const candidate = mix(original, c.foreground, step / 20);
      if (contrast(candidate, c.background) >= 4.5 && contrast(candidate, c.muted) >= 4.5) {
        c["muted-foreground"] = candidate;
        break;
      }
    }
  }
}

function cleanLabel(raw: string, max: number): string {
  return raw.replace(/[\r\n\t`*_<>{}[\]\\"]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();
}

function fontName(raw: string): string | null {
  const want = raw.trim().toLowerCase();
  return Object.keys(BRIEF_FONTS).find((f) => f.toLowerCase() === want) ?? null;
}

export function allowedFonts(named: { heading: string | null; body: string | null }, idea: string): { heading: string; body: string } {
  if (named.heading && named.body) return { heading: named.heading, body: named.body };
  const pair =
    BRIEF_FONT_PAIRS.find((p) => (named.heading && p.heading === named.heading) || (named.body && p.body === named.body)) ?? fontPairForIdea(idea);
  return { heading: named.heading ?? pair.heading, body: named.body ?? pair.body };
}

export function parseDesignBrief(raw: string, opts: { idea?: string } = {}): DesignBrief | null {
  const candidates = [raw.match(/<brief_json>([\s\S]*?)<\/brief_json>/)?.[1], raw.match(/\{[\s\S]*\}/)?.[0]].filter(
    (c): c is string => typeof c === "string",
  );
  for (const candidate of candidates) {
    let parsed: z.infer<typeof BriefSchema>;
    let json: { plan?: unknown };
    try {
      json = JSON.parse(candidate.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
      parsed = BriefSchema.parse(json);
    } catch {
      continue;
    }
    const named = allowedFonts({ heading: fontName(parsed.fonts.heading), body: fontName(parsed.fonts.body) }, opts.idea ?? "");
    const { heading, body } = typeof opts.idea === "string" ? distinctiveFonts(named, opts.idea) : named;
    const c = Object.fromEntries(BRIEF_COLOR_TOKENS.map((k) => [k, parsed.colors[k].toLowerCase()])) as Record<BriefColorToken, string>;
    const replaced: BriefColorToken[] = [];
    if (typeof opts.idea === "string" && !earthyIdea(opts.idea)) {
      const neutral = parsed.mode === "dark" ? DARK_NEUTRAL : STARTER_COLORS;
      for (const k of BRIEF_COLOR_TOKENS) {
        if (isEarthy(c[k])) {
          c[k] = neutral[k];
          replaced.push(k);
        }
      }
    }
    repairBriefContrast(c);
    return {
      industry: cleanLabel(parsed.industry, 60),
      mood: cleanLabel(parsed.mood, 80),
      mode: parsed.mode,
      colors: c,
      fonts: { heading, body },
      ...((plan) => (plan ? { plan } : {}))(parseSitePlan(json.plan, opts.idea)),
      ...(replaced.length ? { earthy_replaced: replaced } : {}),
      ...parseBriefExtras(json, typeof opts.idea === "string" ? decodeXmlEntities(opts.idea) : undefined),
      source: "model" as const,
    };
  }
  return null;
}

export type DesignBriefCall = (input: { system: string; user: string; signal: AbortSignal }) => Promise<string>;

const realCall: DesignBriefCall = async ({ system, user, signal }) => {
  const resp = await createMessageWithFailover(
    {
      model: MODELS.anthropic.haiku,
      max_tokens: 3000,
      system: [cachedSystemBlock(system)],
      messages: [{ role: "user", content: user }],
    },
    { signal },
  );
  return resp.content.map((block) => (block.type === "text" ? block.text : "")).join("");
};

export const DESIGN_BRIEF_SYSTEM = `You are the brand designer and content planner for a new small-business website. From the founder's idea, pick a look that fits this specific business and its customers, and plan what the site says.

Return only a JSON object inside <brief_json> tags:
{"industry": "...", "mood": "three words", "mode": "light" | "dark", "colors": {"background": "#rrggbb", "foreground": "#rrggbb", "muted": "#rrggbb", "muted-foreground": "#rrggbb", "primary": "#rrggbb", "primary-foreground": "#rrggbb", "border": "#rrggbb"}, "fonts": {"heading": "...", "body": "..."}, "audience": "...", "positioning": "...", "facts": ["..."], "imagery": {"subjects": ["..."], "style": "..."}, "look": {"base": "<preset>", "layout": "<layout>", "alternates": ["<preset>", "<preset>"]}, "visual_intent": {"given": true | false, "quote": "..."}, "logo": {"icon": "<icon>" | null, "shape": "rounded" | "circle"}, "plan": {"tone": "...", "primary_action": {"label": "...", "steps": "..."}, "pages": [{"path": "/", "title": "Home", "sections": [{"name": "...", "headline": "...", "component": "...", "variant": "...", "tone": "...", "image": {"role": "...", "subject": "..."}}]}]}}

Rules:
1. If the idea names colours, a mood, a style or a layout, follow it exactly.
2. Otherwise choose colours a designer would choose for this industry and audience. Earthy colours (brown, taupe, tan, khaki, olive, sage, beige-brown, terracotta) are only for a business that is itself earthy: coffee, tea, bakery, wood, furniture, farm, garden, outdoor, leather, pottery or similar. Yoga, wellness, spa, beauty, health, fitness, education, tech and services are not earthy: give them a clear, fresh palette with a confident brand colour. Never fall back on a generic default: blue, indigo or green only when the business itself calls for them, never as the safe choice.
3. Keep text readable: strong contrast for foreground on background and primary-foreground on primary.
4. Fonts: one heading / body pair from: ${BRIEF_FONT_PAIRS.map((p) => `${p.heading} / ${p.body}`).join("; ")}.
5. Dark mode only when the idea asks for it or the business is clearly nightlife, gaming or similar.
6. Plan: primary_action is the one thing a visitor comes to do (label is its button text, steps is the visitor's path in one sentence). Up to ${PLAN_MAX_PAGES} pages, the first at "/", each with up to ${PLAN_MAX_SECTIONS} sections in display order; each headline is real copy written for this business. Plan only what the idea asks for or a visitor clearly needs; never invent prices, addresses, staff names, testimonials, reviews, ratings, \"trusted by\" lines, customer counts or years in business; no Testimonials or Stats section unless the idea gives those facts. Each section names its component and variant (${Object.entries(PLAN_SECTION_VARIANTS).map(([c, v]) => (v.length ? `${c} ${v.join("|")}` : c)).join("; ")}) and tone (${PLAN_TONES.join("|")}; none on Hero). Only home-page sections may add image {role (${PLAN_IMAGE_ROLES.join("|")}), aspect (${PLAN_IMAGE_ASPECTS.join("|")}), subject (under ${PLAN_IMAGE_SUBJECT_MAX} chars), placement (${PLAN_IMAGE_PLACEMENTS.join("|")}: where the subject sits), overlay (copy on it), optional focal {x, y} 0-100}, at most ${PLAN_MAX_IMAGES} images.
7. audience: who the site is for, one line. positioning: why a visitor picks this business, one line, from the idea.
8. facts: up to ${BRIEF_MAX_FACTS} concrete facts the idea itself states (services, hours, area, prices, how it works), a few words each. Only what the idea says; an empty list is fine.
9. imagery: up to ${BRIEF_MAX_IMAGE_SUBJECTS} photo subjects for this business, the hero first, each a short concrete scene, and one style line that fits the palette. If the idea asks for no photos, subjects is [].
10. look: base is the preset below whose shape (corners, shadows, heading weight) fits your palette best. layout is one of: ${Object.entries(BRIEF_LAYOUTS)
  .map(([k, v]) => `${k} (${v})`)
  .join("; ")}. pick the layout and section components that suit this kind of business (a portfolio shows the work: Hero image or editorial, Gallery feature; a clinic or trade leads with what it does: Features split, FAQ; a booking business leads with what to book; a shop leads with products); avoid the generic hero plus three cards unless it truly fits. alternates: two OTHER presets that suit this business and differ from your look and each other in at least two of: warm/cool colour, light/dark, serif/sans headings, sharp/rounded corners.
11. visual_intent: given only when the idea says how the site should look (colours, style, layout, fonts, a site to copy); quote copies those words. Else false, "".
12. logo.icon: the icon a customer would read as this business (or the logo the founder describes), else null to show the name alone as a wordmark: ${LOGO_ICON_NAMES.join(", ")}.
Presets:
${describeThemePresets(THEME_PRESETS, { compact: true })}`;

export type DesignBriefResult = { brief: DesignBrief } | { brief: null; reason: string };

export function designBriefUserMessage(input: { idea: string; name?: string | null; templateLines?: string | null }): string {
  const name = cleanLabel(String(input.name ?? ""), 60);
  const template = input.templateLines ? `\n\n${input.templateLines.slice(0, 2000)}` : "";
  return `${name ? `BUSINESS NAME: ${name}\n` : ""}THE IDEA:\n${input.idea.slice(0, 3000)}${template}\n\nReturn: <brief_json>{...}</brief_json>`;
}

export async function generateDesignBrief(
  input: { idea: string; name?: string | null; templateLines?: string | null },
  deps: { call?: DesignBriefCall; timeoutMs?: number } = {},
): Promise<DesignBriefResult> {
  const idea = decodeXmlEntities(String(input.idea ?? "")).trim();
  if (idea.length < 8) return { brief: null, reason: "idea_too_short" };
  if (!deps.call && !hasAnthropicAuth()) return { brief: null, reason: "no_model_auth" };
  const user = designBriefUserMessage({ idea, name: input.name, templateLines: input.templateLines });
  let raw: string;
  try {
    raw = await (deps.call ?? realCall)({ system: DESIGN_BRIEF_SYSTEM, user, signal: AbortSignal.timeout(deps.timeoutMs ?? 15_000) });
  } catch (e) {
    return { brief: null, reason: `model_error: ${String((e as Error)?.message ?? e).slice(0, 120)}` };
  }
  const brief = parseDesignBrief(raw, { idea });
  return brief ? { brief } : { brief: null, reason: "unparseable" };
}

function triplet(hex: string): string {
  return rgb(hex).join(" ");
}

function fontStack(font: string): string {
  return `"${font}", ${BRIEF_FONTS[font]?.kind === "serif" ? 'ui-serif, Georgia, "Times New Roman", serif' : 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif'}`;
}

export function googleFontsHref(fonts: DesignBrief["fonts"]): string {
  const families = [...new Set([fonts.heading, fonts.body])].map(
    (f) => `family=${f.replace(/ /g, "+")}:wght@${BRIEF_FONTS[f]!.weights}`,
  );
  return `https://fonts.googleapis.com/css2?${families.join("&")}&display=swap`;
}

export function applyDesignBrief(files: Readonly<Record<string, string>>, brief: DesignBrief): Record<string, string> {
  const out: Record<string, string> = { ...files };
  if (typeof out[THEME_CSS_PATH] === "string") return out;
  const css = out["src/index.css"];
  const html = out["index.html"];
  if (typeof css !== "string" || typeof html !== "string" || !/--primary:/.test(css)) return out;
  let next = css;
  for (const token of BRIEF_COLOR_TOKENS) {
    next = next.replace(new RegExp(`(--${token}:\\s*)[^;]+;`), (_m, lead: string) => `${lead}${triplet(brief.colors[token])};`);
  }
  next = next.replace(/(body\s*\{[^}]*?font-family:\s*)[^;]+;/, (_m, lead: string) => `${lead}${fontStack(brief.fonts.body)};`);
  next = `${next.trimEnd()}\n\nh1,\nh2,\nh3,\nh4 {\n  font-family: ${fontStack(brief.fonts.heading)};\n}\n`;
  if (brief.mode === "dark") next = next.replace(/:root\s*\{/, ":root {\n  color-scheme: dark;");
  out["src/index.css"] = next;
  const links =
    `<link rel="preconnect" href="https://fonts.googleapis.com" />\n` +
    `    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />\n` +
    `    <link rel="stylesheet" href="${googleFontsHref(brief.fonts)}" />\n  </head>`;
  out["index.html"] = html.replace(/\s*<\/head>/, () => `\n    ${links}`);
  return out;
}

export function designBriefSummary(brief: DesignBrief): string {
  const plan = brief.plan
    ? `; plan ${brief.plan.pages.length} page${brief.plan.pages.length === 1 ? "" : "s"}, action "${brief.plan.primary_action.label}"`
    : "; no plan";
  const earthy = brief.earthy_replaced?.length ? `; earthy colours replaced (${brief.earthy_replaced.join(", ")})` : "";
  return `${brief.mood} (${brief.industry}); ${brief.mode}; primary ${brief.colors.primary} on ${brief.colors.background}; fonts ${brief.fonts.heading} / ${brief.fonts.body}${plan}${earthy}`;
}
