import { readSitePreview, SITE_DESIGN_LAYOUTS, type SiteDesignLayout, type SiteLook, type SitePreview } from "./siteDesign";

export type SiteTemplate = {
  id: string;
  label: string;
  blurb: string;
  good_for: string;
  idea: string;
  layout: SiteDesignLayout;
  preview: SitePreview;
};

export const TEMPLATES_OPEN = "Start from a template";
export const TEMPLATES_NOTE = "Each template sets the layout and sections. Colors, fonts and words are made for your business.";
export const TEMPLATES_FAILED = "Templates could not load. You can still describe your idea above.";
export const TEMPLATES_USE = "Use this template";
export const TEMPLATES_PREVIEW = "Preview";
export const TEMPLATES_PREVIEW_BACK = "Back to templates";
export const CONFIRM_WITH_BLANKS = "This goes in the idea box. You can still edit it there.";
export const CONFIRM_NO_BLANKS = "This template needs nothing filled in. Its idea goes in the idea box, where you can edit it.";

const ID = /^[a-z][a-z0-9-]{1,40}$/;

function text(v: unknown, max: number): string | null {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
}

export function readSiteTemplates(raw: unknown): SiteTemplate[] {
  const list = (raw as { templates?: unknown } | null)?.templates;
  if (!Array.isArray(list)) return [];
  const out: SiteTemplate[] = [];
  for (const item of list.slice(0, 24)) {
    const t = (item ?? {}) as Record<string, unknown>;
    const id = typeof t.id === "string" && ID.test(t.id) ? t.id : null;
    const label = text(t.label, 60);
    const idea = text(t.idea, 400);
    const preview = readSitePreview(t.preview);
    if (!id || !label || !idea || !preview) continue;
    out.push({
      id,
      label,
      blurb: text(t.blurb, 160) ?? "",
      good_for: text(t.good_for, 160) ?? "",
      idea,
      layout: SITE_DESIGN_LAYOUTS.find((l) => l === t.layout) ?? "centered",
      preview,
    });
  }
  return out;
}

const BLANK = /\[[^\[\]\n]{1,60}\]/g;
export const ANSWER_MAX = 120;

export function templateBlanks(idea: string): string[] {
  return [...new Set(idea.match(BLANK) ?? [])];
}

export function cleanAnswer(raw: string): string {
  return raw.replace(/[\[\]\r\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, ANSWER_MAX).trim();
}

export function fillTemplateIdea(idea: string, answers: Readonly<Record<string, string>>): string {
  return idea.replace(BLANK, (blank) => cleanAnswer(answers[blank] ?? "") || blank);
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function blankLabel(blank: string): string {
  return blank.replace(/^\[|\]$/g, "").trim();
}

export function blankQuestion(blank: string): string {
  const b = blankLabel(blank);
  const low = b.toLowerCase();
  let m: RegExpExecArray | null;
  if ((m = /^(who|what) you (\S+)(.*)$/i.exec(b))) return `${cap(m[1].toLowerCase())} do you ${m[2]}${m[3]}?`;
  if ((m = /^(who|what) it is(.*)$/i.exec(b))) return `${cap(m[1].toLowerCase())} is it${m[2]}?`;
  if (/^(who|what|where|when|which|how)\b/i.test(b)) return `${cap(b)}?`;
  if (low === "address") return "What is the address?";
  if (/^(town|city|place|area|location|neighbou?rhood|country|region)\b/i.test(b)) return `Which ${b} is it in?`;
  if (/\bname\b/i.test(b)) return `What is the ${b}?`;
  if (b.includes(",") && / or /i.test(b)) return `Which is it: ${b}?`;
  if (/^(kind|type|sort) of /i.test(b)) return `What ${b} is it?`;
  if (/ and /i.test(b) || (/s$/i.test(b) && !/ss$/i.test(b))) return `What are your ${b}?`;
  return `What is your ${b}?`;
}

export function blanksHint(blanks: readonly string[]): string {
  return `Fill in ${blanks.length === 1 ? "the part" : "the parts"} in brackets first: ${blanks.join(", ")}.`;
}

const HUE = {
  mint: "#0e9f6e",
  orange: "#f97316",
  violet: "#7c3aed",
  brand: "#027bff",
  linkedin: "#0073b2",
  marigold: "#e0a800",
  coral: "#ff6b6b",
  rose: "#e11d48",
  teal: "#0d9488",
};
const HUES = Object.values(HUE);
const TEMPLATE_HUE: Record<string, string> = {
  "book-a-service": HUE.mint,
  "menu-and-hours": HUE.orange,
  portfolio: HUE.violet,
  "product-launch": HUE.brand,
  "professional-services": HUE.linkedin,
  "classes-and-events": HUE.marigold,
  community: HUE.coral,
  salon: HUE.rose,
  restaurant: HUE.marigold,
  gym: HUE.orange,
  clinic: HUE.teal,
  agency: HUE.violet,
  shop: HUE.coral,
};

export function templateHue(id: string): string {
  const known = TEMPLATE_HUE[id];
  if (known) return known;
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return HUES[h % HUES.length];
}

const HEX = /^#([0-9a-f]{6})$/i;

function mix(a: string, b: string, t: number): string {
  const x = HEX.exec(a);
  const y = HEX.exec(b);
  if (!x || !y) return a;
  const pa = [0, 2, 4].map((i) => parseInt(x[1].slice(i, i + 2), 16));
  const pb = [0, 2, 4].map((i) => parseInt(y[1].slice(i, i + 2), 16));
  return `#${pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, "0")).join("")}`;
}

export function templateLook(t: SiteTemplate, app: { bg: string; ink: string }): SiteLook {
  const hue = templateHue(t.id);
  return {
    id: t.id,
    label: t.label,
    recommended: false,
    fonts: { display: "", body: "" },
    swatches: {
      background: mix(app.bg, hue, 0.08),
      foreground: app.ink,
      primary: mix(hue, app.ink, 0.25),
      accent: mix(app.bg, hue, 0.3),
      muted: mix(app.bg, hue, 0.18),
    },
    radius: "0.5rem",
    layout: t.layout === "bold" ? "split" : t.layout,
    preview: t.preview,
  };
}
