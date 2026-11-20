
export const SITE_DESIGN_LAYOUTS = ["split", "centered", "editorial", "bold", "minimal"] as const;
export type SiteDesignLayout = (typeof SITE_DESIGN_LAYOUTS)[number];

export type SitePreview = {
  name: string;
  eyebrow?: string;
  headline: string;
  subtitle?: string;
  primary_action?: string;
  hero_variant?: string;
  sections: Array<{ title: string; body?: string; kind?: string }>;
};

export type SiteLook = {
  id: string;
  label: string;
  recommended: boolean;
  fonts: { display: string; body: string };
  swatches: { background: string; foreground: string; primary: string; accent: string; muted: string };
  radius: string;
  layout: SiteDesignLayout;
  preview: SitePreview | null;
};

export type SiteDesign = {
  run_id: string;
  awaiting_pick: boolean;
  deadline_ms: number | null;
  picked: boolean;
  preview: SitePreview | null;
  looks: SiteLook[];
  chosen: string;
  applied: string | null;
  structure: string | null;
  locked: null | "live" | "built" | "ended" | "unsupported";
};

export const BUILD_WITH_LOOK = "Build with this website";
export const PICK_FIRST = "Pick a website to start your build.";
export const PICK_HEADING = "Pick a website";
export const SWITCH_FREE_LINE = "Switch before it's ready and it restyles in seconds, free.";
export const LAYOUT_SET_LINE = " The layout stays; colors and fonts change.";
export const ASK_FOR_NEW_LOOK = "Want a different feel? Just ask.";
export const START_FAILED = "We could not start your build. Try again.";
export const PICK_FAILED = "Your pick did not save. Try again.";

export function selectedLookLine(label: string): string {
  return `Previewing “${label}”. Build with it when you're ready.`;
}

export function countdownLine(label: string, secs: number): string {
  return secs > 0 ? `“${label}” starts in ${secs}s` : `Starting “${label}”…`;
}

export function lookStartedLine(label: string): string {
  return `Building your site in “${label}”.`;
}

export function websiteNumber(i: number): string {
  return `Website ${i + 1}`;
}

const HEX = /^#[0-9a-f]{6}$/i;
const WORD = /^[A-Za-z]{2,20}$/;
const TEXT_MAX = 400;
export const SITE_DESIGN_POLL_MS = 6000;

function text(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t.slice(0, TEXT_MAX) : undefined;
}

function layoutOf(v: unknown): SiteDesignLayout {
  return SITE_DESIGN_LAYOUTS.find((l) => l === v) ?? "centered";
}

export function readSitePreview(raw: unknown): SitePreview | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name = text(r.name);
  const headline = text(r.headline);
  if (!name || !headline) return null;
  const sections = (Array.isArray(r.sections) ? r.sections : [])
    .map((x) => {
      const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
      const title = text(o.title);
      if (!title) return null;
      return { title, body: text(o.body), kind: typeof o.kind === "string" && WORD.test(o.kind) ? o.kind : undefined };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .slice(0, 6);
  return {
    name,
    eyebrow: text(r.eyebrow),
    headline,
    subtitle: text(r.subtitle),
    primary_action: text(r.primary_action),
    hero_variant: typeof r.hero_variant === "string" && WORD.test(r.hero_variant) ? r.hero_variant : undefined,
    sections,
  };
}

export function readSiteDesign(raw: unknown, now: number): SiteDesign | null {
  const d = (raw as { design?: unknown } | null)?.design as Record<string, unknown> | null | undefined;
  if (!d || typeof d !== "object" || !Array.isArray(d.looks) || typeof d.chosen !== "string") return null;
  const looks: SiteLook[] = [];
  for (const raw of d.looks as unknown[]) {
    const l = (raw ?? {}) as Record<string, unknown>;
    const sw = l.swatches as Record<string, unknown> | undefined;
    const fonts = l.fonts as Record<string, unknown> | undefined;
    if (typeof l.id !== "string" || typeof l.label !== "string") continue;
    if (!sw || !["background", "foreground", "primary", "accent", "muted"].every((k) => typeof sw[k] === "string" && HEX.test(sw[k] as string))) continue;
    if (!fonts || typeof fonts.display !== "string" || typeof fonts.body !== "string") continue;
    looks.push({
      id: l.id,
      label: l.label,
      recommended: l.recommended === true,
      fonts: { display: fonts.display, body: fonts.body },
      swatches: sw as SiteLook["swatches"],
      radius: typeof l.radius === "string" ? l.radius : "0.5rem",
      layout: layoutOf(l.layout),
      preview: readSitePreview(l.preview),
    });
  }
  const awaiting = d.awaiting_pick === true;
  const left = d.look_deadline_in_ms;
  const atRaw = typeof d.auto_start_at === "string" ? d.auto_start_at : d.look_deadline_at;
  const at = typeof atRaw === "string" ? Date.parse(atRaw) : NaN;
  const deadline_ms = !awaiting
    ? null
    : typeof left === "number" && Number.isFinite(left) && left >= 0 && left <= 10 * 60_000
      ? now + left
      : Number.isFinite(at)
        ? at
        : null;
  const locked = d.locked;
  return {
    run_id: typeof d.run_id === "string" ? d.run_id : "",
    awaiting_pick: awaiting,
    deadline_ms,
    picked: d.picked === true,
    preview: readSitePreview(d.preview),
    looks,
    chosen: d.chosen,
    applied: typeof d.applied === "string" ? d.applied : null,
    structure: typeof d.structure === "string" ? d.structure : null,
    locked: locked === "live" || locked === "built" || locked === "ended" || locked === "unsupported" ? locked : null,
  };
}

export function shouldPollDesign(design: SiteDesign | null, buildActive: boolean): boolean {
  if (!design) return buildActive;
  return design.awaiting_pick || design.locked === null;
}

export function awaitsPick(design: SiteDesign | null, started: string | null): boolean {
  return !!design && design.awaiting_pick && !design.picked && started === null && design.looks.length > 0;
}

export function recommendedLook(design: SiteDesign): SiteLook | null {
  return design.looks.find((l) => l.recommended) ?? design.looks.find((l) => l.id === design.chosen) ?? design.looks[0] ?? null;
}

export function secondsLeft(deadlineMs: number | null, now: number): number | null {
  return deadlineMs === null ? null : Math.max(0, Math.ceil((deadlineMs - now) / 1000));
}

export function collapsedLook(design: SiteDesign, started: string | null): { name: string; canChange: boolean } {
  const open = design.locked === null;
  const id = open ? (started ?? design.chosen) : (design.applied ?? design.chosen);
  const current = design.looks.find((l) => l.id === id);
  return { name: current?.label ?? "the recommended look", canChange: open };
}

const DEFAULT_FEATURES = ["What we offer", "How it works", "Why choose us"];

type MiniPage = {
  name: string;
  eyebrow: string | null;
  headline: string;
  subtitle: string | null;
  action: string;
  links: string[];
  hero: "split" | "centered" | "left";
  features: Array<{ title: string; body: string | null }>;
  band: { kind: "quote" | "cta"; text: string };
};

export function miniPage(look: SiteLook, fallback: SitePreview | null): MiniPage {
  const p = look.preview ?? fallback ?? { name: "Your business", headline: "Your new website", primary_action: "Get in touch", sections: [] };
  const own = p.sections
    .filter((s) => s.kind !== "Testimonials" && s.kind !== "CTA")
    .map((s) => ({ title: s.title, body: s.body ?? null }));
  const seen = new Set(own.map((i) => i.title.toLowerCase()));
  const features = [...own, ...DEFAULT_FEATURES.filter((t) => !seen.has(t.toLowerCase())).map((title) => ({ title, body: null }))].slice(0, 3);
  const quote = p.sections.find((s) => s.kind === "Testimonials");
  const cta = p.sections.find((s) => s.kind === "CTA");
  const heroVariant = p.hero_variant ?? (look.layout === "split" ? "split" : look.layout === "centered" ? "centered" : "left");
  return {
    name: p.name,
    eyebrow: p.eyebrow ?? null,
    headline: p.headline,
    subtitle: p.subtitle ?? null,
    action: p.primary_action ?? "Get in touch",
    links: [...features.slice(0, 2).map((f) => f.title), "Contact"],
    hero: heroVariant === "split" ? "split" : heroVariant === "centered" ? "centered" : "left",
    features,
    band: quote
      ? { kind: "quote", text: quote.body ?? quote.title }
      : { kind: "cta", text: cta?.body ?? cta?.title ?? `Ready to start with ${p.name}?` },
  };
}

export function tileRadius(radius: string): number {
  const m = /^([\d.]+)(rem|px)?$/.exec(radius.trim());
  if (!m) return 4;
  const px = m[2] === "px" ? Number(m[1]) : Number(m[1]) * 16;
  return Number.isFinite(px) ? Math.min(12, Math.round(px / 2)) : 4;
}
