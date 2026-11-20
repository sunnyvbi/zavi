

export function companyName(factName: string | null | undefined, workspaceName: string | null | undefined): string {
  return factName?.trim() || workspaceName?.trim() || "your company";
}

export function noDescriptionLine(canEdit: boolean): string {
  return canEdit ? "Add a line on what the company does, so Zavi stops guessing." : "No description yet.";
}

export function foundLabel(open: boolean, count: number): string {
  if (open) return "Hide what Zavi found";
  return count > 0 ? `What Zavi found (${count})` : "What Zavi found";
}

export function hostOf(url: string): string {
  const m = /^https?:\/\/([^/?#]+)/i.exec(url ?? "");
  return m ? m[1].replace(/^www\./, "") : "";
}

const LABEL: Record<string, string> = {
  google_analytics: "Google Analytics",
  google_search_console: "Search Console",
  google_ads: "Google Ads",
  meta_ads: "Meta Ads",
  github: "GitHub",
  posthog: "PostHog",
  operator_db: "Your database",
  hubspot: "HubSpot",
  linkedin: "LinkedIn",
  tiktok: "TikTok",
  youtube: "YouTube",
  tiktok_ads: "TikTok Ads",
  reddit_ads: "Reddit Ads",
  x_ads: "X Ads",
  linkedin_ads: "LinkedIn Ads",
};

export function connectorLabel(slug: string): string {
  const bare = slug.replace(/^(?:pipedream|composio)\./, "");
  if (LABEL[bare]) return LABEL[bare];
  const words = bare.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function sourcesLine(working: number, broken: number, stale: number): string {
  return `${working} ${working === 1 ? "source" : "sources"} connected${broken > 0 ? ` · ${broken} need reconnecting` : ""}${
    stale > 0 ? ` · ${stale} not syncing` : ""
  }`;
}

export function suggestionsLabel(gaConnected: boolean, anyMeasured: boolean): string {
  return !gaConnected && !anyMeasured ? "Nothing is measured yet. Connect a source to start" : "Worth connecting";
}

export const SUGGESTED_SHOWN = 6;

export function suggestedConnectors(ranked: readonly string[], connected: readonly string[]): string[] {
  const GA = "google_analytics";
  const have = new Set(connected.flatMap((s) => [s, s.replace(/^(?:pipedream|composio)\./, "")]));
  return ranked
    .filter((s) => !have.has(s))
    .map((s, i) => ({ s, i }))
    .sort((a, b) => Number(b.s === GA) - Number(a.s === GA) || a.i - b.i)
    .map((x) => x.s)
    .slice(0, SUGGESTED_SHOWN);
}

export type BaseTone = "default" | "concise" | "friendly" | "professional" | "direct";

export const TONE_LABEL: Record<BaseTone, string> = {
  default: "Default",
  concise: "Concise",
  friendly: "Friendly",
  professional: "Professional",
  direct: "Direct",
};

export const BRAND_VOICE_MAX = 2000;
const MAX_NEVER_SAY = 25;
const MAX_WORD_CHARS = 40;
const RULES_MAX = 2000;

export const NEVER_SAY_PREFIX = "Never use these words or phrases: ";

export function splitWords(value: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value.split(",")) {
    const word = raw.trim().slice(0, MAX_WORD_CHARS);
    const key = word.toLowerCase();
    if (!word || seen.has(key)) continue;
    seen.add(key);
    out.push(word);
    if (out.length >= MAX_NEVER_SAY) break;
  }
  return out;
}

export function splitRules(rule: string): { other: string; words: string[] } {
  const text = (rule ?? "").trim();
  const at = text.toLowerCase().indexOf(NEVER_SAY_PREFIX.toLowerCase());
  if (at < 0) return { other: text, words: [] };
  return {
    other: text.slice(0, at).trim(),
    words: splitWords(text.slice(at + NEVER_SAY_PREFIX.length).replace(/\.$/, "")),
  };
}

export function ruleToNeverSay(rule: string): string[] {
  return splitRules(rule).words;
}

export function neverSayToRule(words: string[]): string {
  const kept = words.map((w) => w.trim()).filter(Boolean).slice(0, MAX_NEVER_SAY);
  return kept.length === 0 ? "" : `${NEVER_SAY_PREFIX}${kept.join(", ")}.`.slice(0, RULES_MAX);
}

export function tonePills(p: { base_tone?: string | null; warm?: boolean; enthusiastic?: boolean }): string[] {
  const base = TONE_LABEL[(p.base_tone ?? "default") as BaseTone] ?? null;
  return [base, p.warm ? "Warm" : null, p.enthusiastic ? "Enthusiastic" : null].filter(
    (t): t is string => Boolean(t) && t !== "Default",
  );
}

export const VOICE_CLAMP_CHARS = 180;

export function voiceInUse(p: { brand_voice?: string | null; updated_by?: string | null }): string | null {
  if (!p.brand_voice?.trim()) return null;
  return p.updated_by === null || p.updated_by === undefined ? "drafted from your site · in use" : "used by every agent";
}

export type BrandKit = {
  primary: string | null;
  accent: string | null;
  bg: string | null;
  text: string | null;
  source: "scrape" | "default" | "manual" | string;
  source_url: string | null;
};

const HEX = /^#[0-9a-fA-F]{6}$/;

export function kitSwatches(kit: BrandKit | null | undefined): Array<{ label: string; hex: string }> {
  if (!kit) return [];
  const fields: Array<[keyof BrandKit, string]> = [
    ["primary", "Main"],
    ["accent", "Accent"],
    ["bg", "Background"],
    ["text", "Text"],
  ];
  return fields.flatMap(([key, label]) => {
    const v = kit[key];
    return typeof v === "string" && HEX.test(v) ? [{ label, hex: v }] : [];
  });
}

export function kitCaption(kit: BrandKit): string {
  if (kit.source === "manual") return "Set by hand";
  if (kit.source === "scrape") {
    const host = kit.source_url ? /^https?:\/\/([^/?#]+)/i.exec(kit.source_url)?.[1] : null;
    return `Read from ${host ?? "your site"}`;
  }
  return "We could not read your site’s colours, so these are ours";
}

export function brandKitOf(body: unknown): BrandKit | null {
  const k = (body as { brand_kit?: unknown } | null)?.brand_kit as Partial<BrandKit> | null | undefined;
  if (!k || typeof k !== "object") return null;
  return {
    primary: typeof k.primary === "string" ? k.primary : null,
    accent: typeof k.accent === "string" ? k.accent : null,
    bg: typeof k.bg === "string" ? k.bg : null,
    text: typeof k.text === "string" ? k.text : null,
    source: typeof k.source === "string" ? k.source : "default",
    source_url: typeof k.source_url === "string" ? k.source_url : null,
  };
}

export const BASE_TONES: readonly BaseTone[] = ["default", "concise", "friendly", "professional", "direct"];

export type VoiceDraft = { brand_voice: string; base_tone: BaseTone; warm: boolean; enthusiastic: boolean; never_say: string };

export function voiceDraftOf(
  p: { brand_voice?: string | null; base_tone?: string | null; warm?: boolean; enthusiastic?: boolean; response_rules?: string | null },
  seedVoice?: string,
): VoiceDraft {
  return {
    brand_voice: seedVoice ?? p.brand_voice ?? "",
    base_tone: BASE_TONES.includes(p.base_tone as BaseTone) ? (p.base_tone as BaseTone) : "default",
    warm: p.warm === true,
    enthusiastic: p.enthusiastic === true,
    never_say: ruleToNeverSay(p.response_rules ?? "").join(", "),
  };
}

export function voicePatch(draft: VoiceDraft, currentRules: string) {
  const keep = splitRules(currentRules).other;
  const sentence = neverSayToRule(splitWords(draft.never_say));
  return {
    brand_voice: draft.brand_voice.slice(0, BRAND_VOICE_MAX),
    base_tone: draft.base_tone,
    warm: draft.warm,
    enthusiastic: draft.enthusiastic,
    response_rules: [keep, sentence].filter(Boolean).join(" ").slice(0, RULES_MAX),
  };
}

export const COLOUR_FIELDS = [
  ["primary", "Main"],
  ["accent", "Accent"],
  ["bg", "Background"],
  ["text", "Text"],
] as const;

export type ColourKey = (typeof COLOUR_FIELDS)[number][0];
export type ColourDraft = Record<ColourKey, string>;

export const toColourDraft = (k: BrandKit): ColourDraft => ({
  primary: k.primary ?? "",
  accent: k.accent ?? "",
  bg: k.bg ?? "",
  text: k.text ?? "",
});

export const isHex = (v: string) => HEX.test(v);

const HEX_EXAMPLE = "#1A73FF";
const HEX_PLACEHOLDER = "#1a73ff";

export const colourPlaceholder = (key: ColourKey) => (key === "primary" ? HEX_PLACEHOLDER : "optional");

export function invalidColour(d: ColourDraft): string | null {
  if (!HEX.test(d.primary)) return `Main colour must be a hex value like ${HEX_EXAMPLE}.`;
  for (const [key, label] of COLOUR_FIELDS.slice(1)) {
    const v = d[key].trim();
    if (v && !HEX.test(v)) return `${label} colour must be a hex value like ${HEX_EXAMPLE}.`;
  }
  return null;
}

export const coloursChanged = (a: ColourDraft, b: ColourDraft) => JSON.stringify(a) !== JSON.stringify(b);

export function kitBody(d: ColourDraft) {
  return { primary: d.primary, accent: d.accent.trim() || null, bg: d.bg.trim() || null, text: d.text.trim() || null };
}

export const COLOURS_NOTE_MANUAL = "Set by hand, so your site is no longer read for these.";
export const COLOURS_NOTE_SITE = "Editing these stops the weekly read of your site, so your choice stays.";
export const VOICE_PLACEHOLDER = "Warm and plain-spoken. Short sentences. We answer the question first, then add the detail.";
export const VOICE_SAVE_ERROR = "Could not save the brand voice.";
export const VOICE_REQUIRED = "Write how you sound first.";
export const VOICE_DISMISS_ERROR = "Could not dismiss that. Try again.";
export const COLOURS_SAVE_ERROR = "The colours could not be saved.";
export const COLOURS_RESET_ERROR = "The colours could not be reset.";

export function voiceDraftBodyOf(raw: unknown): { value: string; from: string } | null {
  const d = (raw as { draft?: { value?: unknown; from?: unknown } | null } | null)?.draft;
  return d && typeof d.value === "string" && d.value.trim() ? { value: d.value, from: typeof d.from === "string" ? d.from : "your site" } : null;
}
