import { decodeXmlEntities } from "@/services/onboarding/enrichment/sanitize";
import { getThemePreset, type ThemePreset } from "@/services/provisioning/templates/vite-react-zavi/theme-presets";
import { BRIEF_FONTS, contrast, type BriefColorToken, type BriefLayout, type DesignBrief } from "./design-brief";
import { lookIsGiven, presetBriefColors, presetFitsIdea, rankPresetsForIdea, variedPresetFor } from "./design-directions";
import { ideaNamesColours } from "./company-brand";

export const SITE_LOOK_INDUSTRY_RULES_SETTING = "site_look_industry_rules" as const;

export type HueBand = readonly [number, number];

export type IndustryLookRule = {
  kind: string;
  words: RegExp;
  preset: string;
  primaryHues: readonly HueBand[];
  minSaturation: number;
  headings: readonly string[];
  layout: BriefLayout;
  genericLayouts: readonly BriefLayout[];
};

export const INDUSTRY_LOOK_RULES: readonly IndustryLookRule[] = Object.freeze([
  {
    kind: "fitness",
    words:
      /\b(gyms?|fitness|cross ?fit|boxing(?! day)|kickboxing|martial arts?|mma|jiu[- ]?jitsu|karate|taekwondo|muay thai|(?:fitness|workout|military|outdoor|bodyweight|hiit|strength|exercise)\s+boot ?camps?|boot ?camps?\s+(?:workouts?|sessions?|classes|fitness|training|exercise)|personal train(?:er|ers|ing)|weightlifting|powerlifting|hiit|gymnastics?|gymnasts?|calisthenics|cheerleaders?|cheerleading|(?:competitive|all[- ]star)\s+cheer|cheer\s+(?:squads?|teams?|gyms?|academy|academies|clubs?|classes|camps?|athletics|coach(?:es|ing)?)|parkour|spin studio|climbing gym)\b/i,
    preset: "midnight",
    primaryHues: [
      [345, 360],
      [0, 100],
    ],
    minSaturation: 0.6,
    headings: ["Bricolage Grotesque", "Archivo", "Space Grotesk", "Outfit"],
    layout: "bold",
    genericLayouts: ["split", "centered", "minimal"],
  },
] satisfies IndustryLookRule[]);

const PLAIN_LOOK_BUSINESS =
  /\b(consult\w*|accountants?|accounting|bookkeep\w*|tax|financ\w*|banks?|banking|invest\w*|wealth|insurance|law|lawyers?|legal|attorneys?|solicitors?|paralegals?|professional services?)\b/i;

const GENERIC_FONTS: ReadonlySet<string> = new Set(["Inter", "Plus Jakarta Sans"]);

const GENERIC_HUES: HueBand = [195, 265];

function hsl(hex: string): { h: number; s: number; l: number } {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = 60 * (max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4);
  return { h, s, l };
}

function inBand(h: number, [lo, hi]: HueBand): boolean {
  return h >= lo && h <= hi;
}

function darkBackground(bg: string): boolean {
  return contrast(bg, "#000000") < contrast(bg, "#ffffff");
}

function highContrast(c: Record<BriefColorToken, string>): boolean {
  return contrast(c.foreground, c.background) >= 12 && contrast(c.primary, c.background) >= 3;
}

function energetic(rule: IndustryLookRule, hex: string): boolean {
  const { h, s, l } = hsl(hex);
  return s >= rule.minSaturation && l >= 0.25 && l <= 0.8 && rule.primaryHues.some((band) => inBand(h, band));
}

function coloursFit(rule: IndustryLookRule, c: Record<BriefColorToken, string>): boolean {
  return (darkBackground(c.background) || highContrast(c)) && energetic(rule, c.primary);
}

function genericColours(c: Record<BriefColorToken, string>): boolean {
  const { h, s } = hsl(c.primary);
  return !darkBackground(c.background) && s >= 0.3 && inBand(h, GENERIC_HUES);
}

function genericFonts(fonts: { heading: string; body: string }): boolean {
  return GENERIC_FONTS.has(fonts.heading) && GENERIC_FONTS.has(fonts.body);
}

function presetFonts(preset: ThemePreset, fallback: { heading: string; body: string }): { heading: string; body: string } {
  return {
    heading: BRIEF_FONTS[preset.fonts.display] ? preset.fonts.display : fallback.heading,
    body: BRIEF_FONTS[preset.fonts.body] ? preset.fonts.body : fallback.body,
  };
}

function presetMood(preset: ThemePreset): string {
  return preset.mood.split(/[:.]/)[0]!.trim().slice(0, 80) || preset.label;
}

function withPresetColours(brief: DesignBrief, preset: ThemePreset): DesignBrief {
  const colors = presetBriefColors(preset);
  const out: DesignBrief = { ...brief, colors, mode: darkBackground(colors.background) ? "dark" : "light", mood: presetMood(preset) };
  delete out.earthy_replaced;
  return out;
}

export function industryLookRule(text: string): IndustryLookRule | null {
  return INDUSTRY_LOOK_RULES.find((r) => r.words.test(text)) ?? null;
}

function applyRule(brief: DesignBrief, rule: IndustryLookRule, ownColours: boolean): DesignBrief {
  const preset = getThemePreset(rule.preset);
  if (!preset) return brief;
  const swapColours = !ownColours && !coloursFit(rule, brief.colors);
  const swapFonts = !rule.headings.includes(brief.fonts.heading);
  const layout = brief.look?.layout;
  const swapLayout = !layout || rule.genericLayouts.includes(layout);
  if (!swapColours && !swapFonts && !swapLayout) return brief;
  let out: DesignBrief = swapColours ? withPresetColours(brief, preset) : { ...brief };
  if (swapFonts) {
    const fonts = presetFonts(preset, brief.fonts);
    out = { ...out, fonts: rule.headings.includes(fonts.heading) ? fonts : { heading: rule.headings[0]!, body: fonts.body } };
  }
  const base = swapColours || !brief.look ? preset.name : brief.look.base;
  out.look = { base, layout: swapLayout ? rule.layout : layout!, alternates: (brief.look?.alternates ?? []).filter((a) => a !== base) };
  return out;
}

function replaceGenericLook(brief: DesignBrief, text: string, ownColours: boolean): DesignBrief {
  if (ownColours || PLAIN_LOOK_BUSINESS.test(text)) return brief;
  if (!genericColours(brief.colors)) return brief;
  const fitting = rankPresetsForIdea(text).find((name) => presetFitsIdea(name, text));
  const pick = fitting ?? (genericFonts(brief.fonts) ? variedPresetFor(text) : null);
  const top = getThemePreset(pick ?? "");
  if (!top) return brief;
  const fonts = presetFonts(top, brief.fonts);
  if (genericColours(presetBriefColors(top)) && genericFonts(fonts)) return brief;
  const out: DesignBrief = { ...withPresetColours(brief, top), fonts };
  if (brief.look) out.look = { ...brief.look, base: top.name, alternates: brief.look.alternates.filter((a) => a !== top.name) };
  return out;
}

export function applyIndustryLook(brief: DesignBrief, idea: string): DesignBrief {
  if (lookIsGiven(brief) || brief.direction_given) return brief;
  const said = decodeXmlEntities(String(idea ?? ""));
  const text = `${said} ${brief.industry ?? ""}`;
  const ownColours = ideaNamesColours(said);
  const rule = industryLookRule(text);
  return rule ? applyRule(brief, rule, ownColours) : replaceGenericLook(brief, text, ownColours);
}
