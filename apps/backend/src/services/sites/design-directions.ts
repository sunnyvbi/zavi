
import {
  DEFAULT_THEME_PRESET,
  THEME_CSS_PATH,
  THEME_PRESETS,
  getThemePreset,
  renderThemeCss,
  resolveTheme,
  validateThemePreset,
  type ThemePreset,
} from "@/services/provisioning/templates/vite-react-zavi/theme-presets";
import { decodeXmlEntities } from "@/services/onboarding/enrichment/sanitize";
import {
  BRIEF_COLOR_TOKENS,
  BRIEF_FONTS,
  applyDesignBrief,
  contrast,
  earthyIdea,
  isBriefLayout,
  parseSitePlan,
  type BriefColorToken,
  type BriefLayout,
  type DesignBrief,
  type SitePlan,
} from "./design-brief";
import { layoutFits, planForLayout, planHeroForLayout } from "./layout-plan";

export const BRAND_DIRECTION_ID = "brand";
export const MAX_DIRECTIONS = 3;

export type DesignDirection = {
  id: string;
  label: string;
  mood: string;
  layout: BriefLayout;
  recommended: boolean;
  preset: ThemePreset;
  plan?: SitePlan;
};

const PRESET_LAYOUTS: Readonly<Record<string, readonly BriefLayout[]>> = {
  clean: ["split", "centered", "minimal"],
  editorial: ["editorial", "minimal"],
  luxe: ["centered", "editorial"],
  fresh: ["split", "centered"],
  midnight: ["bold", "centered"],
  sunny: ["centered", "split", "bold"],
  earthy: ["editorial", "split"],
  trust: ["split", "centered"],
  studio: ["minimal", "editorial"],
  coastal: ["split", "centered"],
  petal: ["centered", "editorial", "split"],
  active: ["bold", "split", "centered"],
  precise: ["split", "minimal", "centered"],
  noir: ["editorial", "centered", "bold"],
};

function presetLayout(name: string): BriefLayout {
  return PRESET_LAYOUTS[name]?.[0] ?? "split";
}

function briefHasPhotos(brief: DesignBrief): boolean {
  const hero = parseSitePlan(brief.plan)?.pages.find((p) => p.path === "/")?.sections.find((s) => s.component === "Hero");
  if (hero) return !!hero.image;
  return !Array.isArray(brief.imagery?.subjects) || brief.imagery.subjects.length !== 0;
}

function brandLayout(brief: DesignBrief): BriefLayout {
  const want = brief.look?.layout && isBriefLayout(brief.look.layout) ? brief.look.layout : presetLayout(brief.look?.base ?? "");
  return layoutFits(want, briefHasPhotos(brief)) ? want : "centered";
}

function assignAlternates(
  brief: DesignBrief,
  candidates: readonly string[],
  fits: (name: string) => boolean = () => true,
  distinct = true,
): Array<{ name: string; layout: BriefLayout }> {
  const photos = briefHasPhotos(brief);
  const brand = brandLayout(brief);
  const taken = new Set<BriefLayout>([brand]);
  const shapes = new Set<string>([structureKey(brief, brand, true)]);
  const names = new Set<string>([brief.look?.base ?? "", BRAND_DIRECTION_ID]);
  const traits: LookTraits[] = [briefTraits(brief)];
  const out: Array<{ name: string; layout: BriefLayout }> = [];
  for (const [fitOnly, need] of [[true, 2], [true, 1], [false, 2], [false, 1]] as const) {
    for (const name of candidates) {
      if (out.length >= MAX_DIRECTIONS - 1) break;
      const preset = getThemePreset(name);
      if (names.has(name) || !preset || (fitOnly && !fits(name))) continue;
      const t = presetTraits(preset);
      if (distinct && traits.some((other) => traitDistance(t, other) < need || traitDistance(t, other, { corners: false }) === 0)) continue;
      const layout = (PRESET_LAYOUTS[name] ?? ["split"]).find(
        (l) => !taken.has(l) && layoutFits(l, photos) && !shapes.has(structureKey(brief, l, false)),
      );
      if (!layout) continue;
      names.add(name);
      taken.add(layout);
      shapes.add(structureKey(brief, layout, false));
      traits.push(t);
      out.push({ name, layout });
    }
  }
  return out;
}

export type LookTraits = { temperature: "warm" | "green" | "cool" | "neutral"; mode: "light" | "dark"; type: "serif" | "sans"; corners: "sharp" | "soft" | "round" };

function hsl(hex: string): { h: number; s: number; l: number } {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = 60 * (max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4);
  return { h, s, l };
}

function temperature(primary: string): LookTraits["temperature"] {
  const { h, s, l } = hsl(primary);
  if (s < 0.2 || l < 0.12 || l > 0.92) return "neutral";
  if (h < 60 || h >= 320) return "warm";
  return h < 160 ? "green" : "cool";
}

function cornersOf(radius: string | undefined): LookTraits["corners"] {
  const rem = /^([\d.]+)rem$/.exec(radius ?? "0.5rem")?.[1];
  const n = radius === "0" ? 0 : Number(rem ?? 0.5);
  return n <= 0.25 ? "sharp" : n >= 1 ? "round" : "soft";
}

function traitsOf(colors: { background: string; primary: string }, display: string, radius: string | undefined): LookTraits {
  return {
    temperature: temperature(colors.primary),
    mode: contrast(colors.background, "#000000") < contrast(colors.background, "#ffffff") ? "dark" : "light",
    type: BRIEF_FONTS[display]?.kind === "serif" ? "serif" : "sans",
    corners: cornersOf(radius),
  };
}

export function presetTraits(preset: ThemePreset): LookTraits {
  return traitsOf(presetBriefColors(preset), preset.fonts.display, preset.radius);
}

export function briefTraits(brief: DesignBrief): LookTraits {
  return traitsOf(brief.colors, brief.fonts.heading, basePreset(brief).radius);
}

export function traitDistance(a: LookTraits, b: LookTraits, opts: { corners?: boolean } = {}): number {
  const keys = opts.corners === false ? (["temperature", "mode", "type"] as const) : (["temperature", "mode", "type", "corners"] as const);
  return keys.filter((k) => a[k] !== b[k]).length;
}

function structureKey(brief: DesignBrief, layout: BriefLayout, recommended: boolean): string {
  const home = structurePlan(brief, layout, recommended)?.pages.find((p) => p.path === "/");
  if (!home || home.sections.some((s) => !s.component)) return layout;
  return JSON.stringify(home.sections.map((s) => [s.name, s.component ?? "", s.variant ?? "", s.tone ?? ""]));
}

function structurePlan(brief: DesignBrief, layout: BriefLayout, recommended: boolean): SitePlan | undefined {
  const plan = parseSitePlan(brief.plan);
  if (!plan) return undefined;
  return recommended ? planHeroForLayout(plan, layout) : planForLayout(plan, layout);
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mixHex(a: string, b: string, t: number): string {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return `#${[0, 1, 2].map((i) => Math.round(x[i] * (1 - t) + y[i] * t).toString(16).padStart(2, "0")).join("")}`;
}

function titleCase(text: string): string {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

function basePreset(brief: DesignBrief): ThemePreset {
  return getThemePreset(brief.look?.base ?? "") ?? getThemePreset(DEFAULT_THEME_PRESET) ?? THEME_PRESETS[0]!;
}

export function brandPreset(brief: DesignBrief): ThemePreset {
  const base = basePreset(brief);
  const c = brief.colors;
  const accent = mixHex(c.primary, c.background, 0.84);
  return {
    ...base,
    name: BRAND_DIRECTION_ID,
    label: titleCase(brief.mood) || "Made for you",
    mood: brief.mood,
    fonts: { display: brief.fonts.heading, body: brief.fonts.body },
    colors: {
      background: c.background,
      foreground: c.foreground,
      primary: c.primary,
      primaryForeground: c["primary-foreground"],
      accent,
      muted: c.muted,
      mutedForeground: c["muted-foreground"],
      border: c.border,
      inverseBackground: c.foreground,
      inverseForeground: c.background,
    },
    bestFor: undefined,
  };
}

export function withCompleteLook(brief: DesignBrief, idea: string): DesignBrief {
  const ranked = alternateCandidates(`${idea} ${brief.industry}`);
  const base = getThemePreset(brief.look?.base ?? "")?.name ?? ranked[0] ?? DEFAULT_THEME_PRESET;
  const layout = brief.look?.layout && isBriefLayout(brief.look.layout) ? brief.look.layout : presetLayout(base);
  const draft: DesignBrief = { ...brief, look: { base, layout, alternates: [] } };
  const text = `${idea} ${brief.industry}`;
  const own = new Set(brief.look?.alternates ?? []);
  const alternates = assignAlternates(draft, [...own, ...ranked], (name) => own.has(name) || presetFitsIdea(name, text)).map((a) => a.name);
  return { ...brief, look: { base, layout, alternates } };
}

export function designDirections(brief: DesignBrief): DesignDirection[] {
  const layout = brandLayout(brief);
  const brand: DesignDirection = {
    id: BRAND_DIRECTION_ID,
    label: titleCase(brief.mood) || "Made for you",
    mood: brief.positioning ? `${brief.mood}. ${brief.positioning}`.slice(0, 160) : brief.mood,
    layout,
    recommended: true,
    preset: brandPreset(brief),
    ...((plan) => (plan ? { plan } : {}))(structurePlan(brief, layout, true)),
  };
  const out: DesignDirection[] = [brand];
  for (const alt of assignAlternates(brief, brief.look?.alternates ?? [], undefined, false)) {
    const preset = getThemePreset(alt.name)!;
    const plan = structurePlan(brief, alt.layout, false);
    out.push({ id: preset.name, label: preset.label, mood: preset.mood, layout: alt.layout, recommended: false, preset, ...(plan ? { plan } : {}) });
  }
  return out;
}

export function findDirection(brief: DesignBrief, id: string, stored?: readonly DesignDirection[] | null): DesignDirection | null {
  const list = stored && stored.length ? stored : designDirections(brief);
  return list.find((d) => d.id === id) ?? null;
}

export function parseStoredDirections(raw: unknown): DesignDirection[] {
  if (!Array.isArray(raw)) return [];
  const out: DesignDirection[] = [];
  for (const item of raw.slice(0, MAX_DIRECTIONS)) {
    const d = item as Partial<DesignDirection> | null;
    if (!d || typeof d.id !== "string" || typeof d.label !== "string" || typeof d.mood !== "string" || !d.preset) continue;
    try {
      validateThemePreset(d.preset);
    } catch {
      continue;
    }
    const plan = d.plan ? parseSitePlan(d.plan) : null;
    out.push({
      id: d.id,
      label: d.label,
      mood: d.mood,
      layout: isBriefLayout(d.layout) ? d.layout : "split",
      recommended: d.recommended === true,
      preset: d.preset,
      ...(plan ? { plan } : {}),
    });
  }
  return out;
}

const WORD = /[a-z]{4,}/g;
const STOP = new Set(["with", "your", "that", "this", "from", "they", "have", "will", "about", "their", "into", "more", "site", "website", "business", "small", "local"]);

function stems(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().match(WORD) ?? []) {
    if (STOP.has(w)) continue;
    out.add(w.replace(/ies$/, "y").replace(/(ch|sh|ss|x|z)es$/, "$1").replace(/([^s])s$/, "$1"));
  }
  return out;
}

const IDEA_WORDS: Readonly<Record<string, readonly string[]>> = {
  clean: ["consultancy", "consulting", "agency", "marketing", "recruiting", "coaching", "tutoring"],
  editorial: ["bakery", "baker", "pastry", "patisserie", "bread", "coffee", "cafe", "restaurant", "bistro", "kitchen", "chef", "catering", "wine", "book", "bookstore", "chocolate", "deli", "brewery", "tearoom"],
  luxe: ["salon", "beauty", "bridal", "wedding", "jewelry", "jewellery", "jeweller", "fashion", "perfume", "nail", "barber", "lash", "makeup", "boutique", "luxury"],
  fresh: ["yoga", "pilates", "meditation", "dentist", "dental", "doctor", "health", "wellness", "therapy", "therapist", "physio", "physiotherapy", "orthopedic", "clinic", "chiropractor", "pharmacy", "nurse", "vet", "veterinary", "groomer", "grooming", "cleaning", "laundry", "nutrition", "dietitian"],
  midnight: ["nightclub", "lounge", "esports", "gaming", "recording studio"],
  sunny: ["dessert", "donut", "doughnut", "candy", "sweet", "gelato", "juice", "smoothie", "party", "birthday", "kids", "children", "toy", "florist", "flower", "balloon", "school", "daycare"],
  earthy: ["garden", "gardening", "landscaping", "landscaper", "farm", "organic", "plant", "pottery", "ceramics", "soap", "herbal", "candle", "retreat", "forest", "camping", "hiking"],
  trust: ["lawyer", "attorney", "solicitor", "accountant", "accounting", "bookkeeping", "finance", "financial", "mortgage", "realtor", "realty", "property", "estate", "insurance", "wealth", "advisor", "notary"],
  studio: ["photography", "photographer", "architect", "architecture", "designer", "gallery", "artist", "film", "filmmaker", "videographer", "portfolio", "creative"],
  coastal: ["travel", "hotel", "resort", "surf", "surfing", "boat", "sailing", "swim", "swimming", "beach", "seafood", "diving", "kayak", "villa", "holiday"],
  petal: ["cake", "cupcake", "macaron", "patisserie", "florist", "flower", "bridal", "bouquet", "gift", "baby shower", "tea party"],
  active: ["bike", "bicycle", "cycling", "cyclist", "scooter", "skiing", "snowboard", "skate", "running", "sport", "sports", "adventure", "outdoor", "climbing", "campervan"],
  precise: ["software", "saas", "startup", "platform", "developer", "automation", "analytics", "dashboard", "fintech", "machine learning"],
  noir: ["tattoo", "cocktail", "speakeasy", "steakhouse", "whisky", "whiskey", "cigar", "jazz", "fine dining", "barbershop"],
};

const VARIED_FALLBACKS = ["editorial", "fresh", "sunny", "coastal", "luxe", "studio"] as const;

const STYLE_WORDS = "dark|moody|neon|cyberpunk|editorial|magazine|newspaper|luxury|luxurious|premium|elegant|glamorous|minimal|minimalist|monochrome|playful|vibrant|colou?rful|cheerful|earthy|rustic|coastal|beachy|nautical|soft|pastels?|airy|centred|centered|serif|sans[- ]serif";
const STYLE_FILLER = `(?:${STYLE_WORDS}|and|&|or|but|yet|very|really|quite|super|more|clean|modern|sleek|simple|bold|warm|cool|bright|light|crisp|red|orange|yellow|green|blue|navy|teal|purple|violet|pink|black|white|gold|silver|brown|beige|grey|gray|olive|sage|coral|cream|maroon|turquoise)`;
const STYLE_NOUN = "(?:themed?|themes|mode|look|feel|style|styled|styling|design|aesthetic|vibes?|palette|colou?rs?|scheme|layout|website|web ?site|site|pages?|homepage|background|fonts?|typography|typefaces?|type|headings?|headlines?|hero|sections?|text|ui|template|branding)";
const STYLE_LEAD = "(?:(?:make|making|keep|keeping|want|wants|wanted|like|love|prefer|style)\\s+(?:it|this|the\\s+(?:site|website|page|design))(?:\\s+(?:to\\s+)?(?:look|feel|be|seem))?|looks?|looking|feels?|feeling|seems?|(?:should|must|could)\\s+(?:look|feel|be)|go(?:ing)?\\s+for(?:\\s+an?|\\s+something)?|something)";

function styleAsked(words: string): RegExp {
  const word = `(?:${words})`;
  return new RegExp(`\\b(?:${word}(?:[\\s,/-]+${STYLE_FILLER})*[\\s,/-]+${STYLE_NOUN}|${STYLE_LEAD}(?:[\\s,]+${STYLE_FILLER})*?[\\s,]+${word})\\b`, "i");
}

const EXPLICIT_STYLE_PRESETS: ReadonlyArray<readonly [RegExp, string]> = [
  [styleAsked("dark|moody|neon|cyberpunk"), "midnight"],
  [styleAsked("editorial|magazine|newspaper"), "editorial"],
  [styleAsked("luxury|luxurious|premium|elegant|glamorous"), "luxe"],
  [styleAsked("minimal|minimalist|monochrome"), "studio"],
  [styleAsked("playful|vibrant|colou?rful|cheerful"), "sunny"],
  [styleAsked("earthy|rustic"), "earthy"],
  [styleAsked("coastal|beachy|nautical"), "coastal"],
  [/\bsoft pastels?\b/i, "fresh"],
  [styleAsked("soft|pastels?|airy"), "fresh"],
];

const EXPLICIT_LAYOUTS: ReadonlyArray<readonly [RegExp, BriefLayout]> = [
  [/\b(?:split[- ]screen|two[- ]column)\b/i, "split"],
  [styleAsked("centred|centered"), "centered"],
  [styleAsked("editorial|magazine"), "editorial"],
  [/\b(?:bold typography|oversized type|high[- ]contrast)\b/i, "bold"],
  [styleAsked("minimal|minimalist|monochrome"), "minimal"],
];

const DARK_ASKED = styleAsked("dark");
const EXPLICIT_VISUAL_RES: readonly RegExp[] = [
  ...EXPLICIT_STYLE_PRESETS.map(([pattern]) => pattern),
  ...EXPLICIT_LAYOUTS.map(([pattern]) => pattern),
  styleAsked("serif|sans[- ]serif"),
];

const EXPLICIT_COLOURS: Readonly<Record<string, string>> = {
  red: "#dc2626",
  orange: "#ea580c",
  yellow: "#ca8a04",
  green: "#15803d",
  blue: "#2563eb",
  navy: "#1e3a5f",
  teal: "#0f766e",
  purple: "#7e22ce",
  violet: "#7c3aed",
  pink: "#db2777",
  black: "#0a0a0a",
  white: "#ffffff",
  gold: "#b7791f",
  silver: "#64748b",
  brown: "#92400e",
  beige: "#d6c7a1",
  grey: "#52525b",
  gray: "#52525b",
  olive: "#6b7a2d",
  sage: "#6b8f71",
  coral: "#e85d4a",
  cream: "#fff7e6",
  maroon: "#881337",
  turquoise: "#0f766e",
};

const EXPLICIT_COLOUR_RE = new RegExp(`#[0-9a-f]{6}\\b|\\b(?:${Object.keys(EXPLICIT_COLOURS).join("|")})\\b`, "gi");
const EXPLICIT_COLOUR_CONTEXT_RE = /\b(?:colou?rs?|palette|background|accents?|theme|brand colou?r)\b/i;

function ideaWordScore(name: string, words: Set<string>): number {
  let score = 0;
  for (const tag of IDEA_WORDS[name] ?? []) {
    const tagWords = [...stems(tag)];
    if (tagWords.length > 0 && tagWords.every((w) => words.has(w))) score += 2 * tagWords.length;
  }
  return score;
}

export function rankPresetsForIdea(idea: string): string[] {
  const words = stems(decodeXmlEntities(String(idea ?? "")));
  const earthy = earthyIdea(idea);
  const turn = ideaHash(idea) % THEME_PRESETS.length;
  const scored = THEME_PRESETS.map((p, i) => {
    let score = ideaWordScore(p.name, words);
    score += bestForScore(p, words);
    for (const w of stems(p.mood)) if (words.has(w)) score += 1;
    if (p.name === "earthy" && !earthy) score -= 3;
    const order = score > 0 ? i : (i - turn + THEME_PRESETS.length) % THEME_PRESETS.length;
    return { name: p.name, score: p.name === DEFAULT_THEME_PRESET && score <= 0 ? score - 0.5 : score, order };
  });
  return scored.sort((a, b) => b.score - a.score || a.order - b.order).map((s) => s.name);
}

export function variedPresetFor(idea: string): string {
  return VARIED_FALLBACKS[ideaHash(idea) % VARIED_FALLBACKS.length]!;
}

function ideaHash(idea: string): number {
  const text = decodeXmlEntities(String(idea ?? "")).trim().toLowerCase();
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  return hash;
}

const SPECIALIST_PRESETS: ReadonlySet<string> = new Set(["midnight", "noir", "petal", "active", "sunny"]);

export function alternateCandidates(idea: string): string[] {
  return rankPresetsForIdea(idea).filter((name) => !SPECIALIST_PRESETS.has(name) || presetFitsIdea(name, idea));
}

export function presetFitsIdea(name: string, idea: string): boolean {
  const words = stems(decodeXmlEntities(String(idea ?? "")));
  const preset = getThemePreset(name);
  return ideaWordScore(name, words) > 0 || (!!preset && bestForScore(preset, words) > 0);
}

function bestForScore(preset: ThemePreset, words: Set<string>): number {
  let score = 0;
  for (const tag of preset.bestFor ?? []) {
    const tagWords = [...stems(tag)].filter((w) => w !== "and");
    if (tagWords.length > 0 && tagWords.every((w) => words.has(w))) score += 2 * tagWords.length;
  }
  return score;
}

function fallbackPresetName(idea: string, ranked: string[]): string {
  const said = decodeXmlEntities(String(idea ?? ""));
  const explicit = EXPLICIT_STYLE_PRESETS.find(([pattern]) => pattern.test(said))?.[1];
  if (explicit) return explicit;
  const top = ranked[0] ?? DEFAULT_THEME_PRESET;
  if (presetFitsIdea(top, idea)) return top;
  return variedPresetFor(idea);
}

function readableForeground(background: string): string {
  return contrast("#111827", background) >= contrast("#ffffff", background) ? "#111827" : "#ffffff";
}

function explicitDirection(idea: string, colors: Record<BriefColorToken, string>, fallbackLayout: BriefLayout): Pick<DesignBrief, "colors" | "mode" | "direction_given" | "look_given"> & { layout: BriefLayout } | null {
  const text = decodeXmlEntities(String(idea ?? "")).trim();
  const found = [...text.matchAll(EXPLICIT_COLOUR_RE)];
  const hasExplicitColours = found.length >= 2 || found.some((m) => m[0]!.startsWith("#")) || (found.length > 0 && EXPLICIT_COLOUR_CONTEXT_RE.test(text));
  const matches = hasExplicitColours ? found : [];
  if (matches.length === 0 && !EXPLICIT_VISUAL_RES.some((pattern) => pattern.test(text))) return null;
  const named = matches.map((m) => m[0]!.toLowerCase());
  const hexes = named.map((name) => (name.startsWith("#") ? name : EXPLICIT_COLOURS[name]!));
  const chromatic = hexes.find((_hex, index) => !/^(?:black|white|cream|beige|grey|gray|silver)$/.test(named[index]!));
  const wantsDark = DARK_ASKED.test(text) || /\bblack\s+(?:background|page|theme)\b/i.test(text);
  const background = wantsDark && named.includes("black") ? EXPLICIT_COLOURS.black : named.includes("cream") ? EXPLICIT_COLOURS.cream : named.includes("white") ? EXPLICIT_COLOURS.white : colors.background;
  const foreground = readableForeground(background);
  const primary = chromatic ?? (named.includes("black") && background !== EXPLICIT_COLOURS.black ? EXPLICIT_COLOURS.black : colors.primary);
  const mode = contrast(background, "#000000") < contrast(background, "#ffffff") ? "dark" : "light";
  const layout = EXPLICIT_LAYOUTS.find(([pattern]) => pattern.test(text))?.[1] ?? fallbackLayout;
  return {
    colors: {
      ...colors,
      background,
      foreground,
      muted: mode === "dark" ? "#18181b" : colors.muted,
      "muted-foreground": mode === "dark" ? "#a1a1aa" : colors["muted-foreground"],
      primary,
      "primary-foreground": readableForeground(primary),
      border: mode === "dark" ? "#3f3f46" : colors.border,
    },
    mode,
    layout,
    direction_given: text.slice(0, 160),
    look_given: "idea",
  };
}

export function presetBriefColors(preset: ThemePreset): Record<BriefColorToken, string> {
  const t = resolveTheme(preset);
  return {
    background: t.background,
    foreground: t.foreground,
    muted: t.muted,
    "muted-foreground": t.mutedForeground,
    primary: t.primary,
    "primary-foreground": t.primaryForeground,
    border: t.border,
  };
}

function fontOrDefault(family: string, kind: "display" | "body"): string {
  if (BRIEF_FONTS[family]) return family;
  return kind === "display" ? "DM Sans" : "Inter";
}

export function briefForDirection(brief: DesignBrief, direction: DesignDirection): DesignBrief {
  if (direction.id === BRAND_DIRECTION_ID) return brief;
  const colors = presetBriefColors(direction.preset);
  return {
    ...brief,
    mood: direction.preset.mood.slice(0, 80),
    mode: contrast(colors.background, "#000000") < contrast(colors.background, "#ffffff") ? "dark" : "light",
    colors,
    fonts: { heading: fontOrDefault(direction.preset.fonts.display, "display"), body: fontOrDefault(direction.preset.fonts.body, "body") },
  };
}

export const THEME_EDIT_RULE =
  "A colour or font the founder asks for across the whole site is a token change in one place: when the site has `src/theme.css` (written by Zavi from its chosen look; never edit it), set the token in the `:root` block of `src/index.css`, which wins over theme.css (colours as space-separated RGB like `--primary: 190 18 60;`, fonts as `--font-display` / `--font-body` plus that font's Google Fonts `<link>` in `index.html`); a site without theme.css keeps its tokens in `src/index.css` itself.";

export function lookIsGiven(brief: Pick<DesignBrief, "look_given">): boolean {
  return brief.look_given === "idea" || brief.look_given === "references" || brief.look_given === "template";
}

export function briefWithStructure(brief: DesignBrief, direction: DesignDirection): DesignBrief {
  return {
    ...brief,
    ...(brief.look ? { look: { ...brief.look, layout: direction.layout } } : {}),
    ...(direction.plan ? { plan: direction.plan } : {}),
  };
}

export type ChosenLookRow = {
  brief: DesignBrief;
  directions: readonly DesignDirection[];
  chosen_direction: string;
  build_direction?: string | null;
};

export function structureDirection(row: ChosenLookRow): DesignDirection | null {
  return findDirection(row.brief, row.build_direction ?? row.chosen_direction, row.directions);
}

export function briefForChosenLook(row: ChosenLookRow): DesignBrief {
  const theme = findDirection(row.brief, row.chosen_direction, row.directions);
  const styled = theme ? briefForDirection(row.brief, theme) : row.brief;
  const structure = structureDirection(row);
  return structure ? briefWithStructure(styled, structure) : styled;
}

export type ThemeMode = "theme_css" | "index_css" | "none";

export function themeModeOf(files: Readonly<Record<string, string>>): ThemeMode {
  if (typeof files[THEME_CSS_PATH] === "string") return "theme_css";
  const css = files["src/index.css"];
  const html = files["index.html"];
  if (typeof css === "string" && typeof html === "string" && /--primary:/.test(css)) return "index_css";
  return "none";
}

export function liveSwitchable(mode: ThemeMode): boolean {
  return mode === "theme_css";
}

export function applyDirectionToFiles(
  files: Readonly<Record<string, string>>,
  brief: DesignBrief,
  direction: DesignDirection,
): Record<string, string> {
  const mode = themeModeOf(files);
  if (mode === "theme_css") {
    try {
      return { ...files, [THEME_CSS_PATH]: renderThemeCss(direction.preset) };
    } catch {
      return { ...files };
    }
  }
  if (mode === "index_css") return applyDesignBrief(files, briefForDirection(brief, direction));
  return { ...files };
}

export function directionInThemeCss(css: string): string | null {
  const m = /^\/\* Theme "([a-z][a-z0-9-]{1,30})"/.exec(css.trimStart());
  return m ? m[1]! : null;
}

export function fallbackDesignBrief(input: { idea: string }): DesignBrief {
  const pick = fallbackPresetName(input.idea, rankPresetsForIdea(input.idea));
  const ranked = [pick, ...alternateCandidates(input.idea).filter((n) => n !== pick)];
  const base = getThemePreset(pick) ?? THEME_PRESETS[0]!;
  const baseColors = presetBriefColors(base);
  const explicit = explicitDirection(input.idea, baseColors, presetLayout(base.name));
  const colors = explicit?.colors ?? baseColors;
  const brief: DesignBrief = {
    industry: "",
    mood: base.mood.split(/[:.]/)[0]!.trim().slice(0, 80) || base.label,
    mode: explicit?.mode ?? (contrast(colors.background, "#000000") < contrast(colors.background, "#ffffff") ? "dark" : "light"),
    colors,
    fonts: { heading: fontOrDefault(base.fonts.display, "display"), body: fontOrDefault(base.fonts.body, "body") },
    look: { base: base.name, layout: explicit?.layout ?? presetLayout(base.name), alternates: [] },
    ...(explicit ? { direction_given: explicit.direction_given, look_given: explicit.look_given } : {}),
    source: "fallback",
  };
  return { ...brief, look: { ...brief.look!, alternates: assignAlternates(brief, ranked, (name) => presetFitsIdea(name, input.idea)).map((a) => a.name) } };
}

export function isStoredBrief(raw: unknown): raw is DesignBrief {
  const b = raw as Partial<DesignBrief> | null;
  if (!b || typeof b !== "object" || typeof b.mood !== "string") return false;
  const colors = b.colors as Record<string, unknown> | undefined;
  if (!colors || BRIEF_COLOR_TOKENS.some((k) => typeof colors[k] !== "string" || !/^#[0-9a-f]{6}$/i.test(colors[k] as string))) return false;
  return typeof b.fonts?.heading === "string" && typeof b.fonts?.body === "string";
}
