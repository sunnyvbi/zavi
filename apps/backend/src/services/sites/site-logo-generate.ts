import { createHash } from "node:crypto";
import { decodeXmlEntities } from "@/services/onboarding/enrichment/sanitize";
import type { MediaAspect, MediaFailReason, MediaTask } from "@/services/media-router/types";
import { sanitizeSvg } from "@/services/media-router/svg";
import { SITE_CONFIG_PATH, SITE_LOGO_PATH, SITE_LOGO_URL, siteSourceWithLogo, siteSourceWithoutLogo } from "./site-head";
import type { SiteSandbox } from "./contract";
import type { DirectChangeFile, DirectChangePlan } from "./site-direct-change";
import { readSandboxFiles } from "./site-direct-change";
import { logoLetters, renderSiteLogo } from "./site-logo";
import { parseThemeCss } from "./site-theme-edit";
import { THEME_CSS_PATH } from "@/services/provisioning/templates/vite-react-zavi/theme-presets";
import { DEV_STUB_MODEL } from "@/services/media-router/dev-stub";
import {
  designSiteLogo,
  directedLogoType,
  hasRealLogoName,
  logoInitials,
  logoRenderPrompt,
  LOGO_PLACEHOLDER_NAME,
  LOGO_RENDER_PROMPT_MAX,
  type LogoDesignInput,
  type LogoDesignResult,
  type LogoDesignSpec,
} from "./site-logo-design";

export { logoInitials };

export const SITE_FAVICON_PATH = "public/favicon.svg";
export const SITE_APP_PATH = "src/App.tsx";
export const LOGO_PROMPT_MIN = 3;
export const LOGO_PROMPT_MAX = 400;
const MAX_LOGO_BYTES = 2 * 1024 * 1024;

export type BuildLogoInput = { tenant_id: string; run_id: string; site_name: string; idea: string; primary?: string; accent?: string };

export type LogoRequest = { description: string };
export type LogoSnapshot = { logo: string | null; favicon: string | null; site: string | null; app: string | null };
export type PreparedLogo = { svg: string; model: string; cost_usd: number; charge: { task: "image.vector"; cost_usd: number }; design?: LogoDesignSpec };
export type LogoGenerationError =
  | "insufficient_credits"
  | "credits_unavailable"
  | "not_configured"
  | "generation_failed"
  | "download_failed"
  | "unsafe_svg";

export type LogoGenerationDeps = {
  configured: (task: MediaTask) => Promise<boolean>;
  estimate: (task: MediaTask, req: { prompt: string; aspect_ratio: MediaAspect }) => Promise<number>;
  afford: (tenant_id: string, cost_usd: number) => Promise<"ok" | "short" | "unknown">;
  generate: (
    task: MediaTask,
    req: { prompt: string; aspect_ratio: MediaAspect },
  ) => Promise<{ ok: true; url: string; cost_usd: number; model: string } | { ok: false; reason: MediaFailReason; error: string }>;
  download: (url: string, maxBytes: number) => Promise<Uint8Array | null>;
  design?: (input: LogoDesignInput) => Promise<LogoDesignResult>;
};

export function generatedLogoUrl(svg: string): string {
  return `${SITE_LOGO_URL}?v=${createHash("sha256").update(svg).digest("hex").slice(0, 12)}`;
}

export function siteNameFrom(siteSource: string | null | undefined): string {
  const m = /\bname\s*:\s*(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\$\n]|\\.)*)`)/.exec(siteSource ?? "");
  if (!m) return "";
  const raw = m[1] ?? m[2] ?? m[3] ?? "";
  try {
    return JSON.parse(`"${raw.replace(/\\(['`])/g, "$1").replace(/(^|[^\\])"/g, '$1\\"')}"`) as string;
  } catch {
    return raw;
  }
}

function onColor(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "#ffffff";
  const n = parseInt(m[1]!, 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.6 ? "#111827" : "#ffffff";
}

export function initialsFavicon(name: string, themeCss: string | null): string | null {
  const preset = themeCss ? parseThemeCss(themeCss) : null;
  const primary = preset?.colors.primary ?? "#111827";
  const mark = renderSiteLogo({ icon: null, shape: "rounded", letters: logoLetters(name) }, { primary, primaryForeground: preset?.colors.primaryForeground ?? onColor(primary) });
  return mark?.favicon ?? null;
}

export function siteAppUsesLogo(source: string): boolean {
  return /\bSITE\.logo\b/.test(source);
}

export function cleanLogoRequest(raw: unknown): LogoRequest | null {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const description = typeof r.description === "string" ? r.description.replace(/\s+/g, " ").trim() : "";
  return description.length >= LOGO_PROMPT_MIN && description.length <= LOGO_PROMPT_MAX ? { description } : null;
}

export type LogoBusiness = { summary?: string; industry?: string; tagline?: string; offers?: string[]; audience?: string; positioning?: string };

function plain(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().replace(/[.;:,]+$/, "");
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export function siteTaglineFrom(siteSource: string | null | undefined): string {
  const m = /\btagline\s*:\s*("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)/.exec(siteSource ?? "");
  if (!m) return "";
  const raw = m[1]!;
  try {
    return raw.startsWith('"') ? (JSON.parse(raw) as string) : raw.slice(1, -1).replace(/\\(.)/g, "$1");
  } catch {
    return raw.slice(1, -1);
  }
}

export function logoBusinessFrom(
  brief: { industry?: unknown; audience?: unknown; positioning?: unknown; facts?: unknown } | null | undefined,
  siteSource: string | null | undefined,
): LogoBusiness {
  const tagline = plain(siteTaglineFrom(siteSource), 160);
  const offers = Array.isArray(brief?.facts) ? brief!.facts.map((f) => plain(f, 90)).filter(Boolean).slice(0, 4) : [];
  const out: LogoBusiness = {};
  const industry = plain(brief?.industry, 80);
  const audience = plain(brief?.audience, 140);
  const positioning = plain(brief?.positioning, 160);
  if (industry) out.industry = industry;
  if (tagline && !/^a new site, coming soon$/i.test(tagline)) out.tagline = tagline;
  if (offers.length) out.offers = offers;
  if (audience) out.audience = audience;
  if (positioning) out.positioning = positioning;
  return out;
}

function businessLine(b: LogoBusiness | undefined, level: number): string {
  if (!b) return "";
  const parts = [
    b.summary ? `What it is: ${b.summary}` : "",
    b.industry ? `It is a ${b.industry}` : "",
    b.tagline ? `Its line: "${b.tagline}"` : "",
    b.offers?.length && level < 3 ? `It offers: ${b.offers.slice(0, level < 2 ? 4 : 2).join("; ")}` : "",
    b.audience && level < 1 ? `For: ${b.audience}` : "",
    b.positioning && level < 2 ? `Why customers choose it: ${b.positioning}` : "",
  ].filter(Boolean);
  return parts.length ? `About the business: ${parts.join(". ")}. Make the symbol say what this business is and does.` : "";
}

export type LogoMode = "symbol" | "monogram";

export function logoMode(description: string, siteName: string = LOGO_PLACEHOLDER_NAME): LogoMode {
  return directedLogoType(description) === "monogram" && hasRealLogoName(siteName) ? "monogram" : "symbol";
}

function iconPrompt(input: { site_name: string; description: string; business?: string; primary?: string; accent?: string; about?: LogoBusiness }): string {
  const colors = [input.primary, input.accent].filter((value): value is string => !!value).join(" and ");
  const mode = logoMode(input.description, input.site_name);
  const direction = directedLogoType(input.description) === "wordmark" ? "" : input.description;
  const modeLine =
    mode === "monogram"
      ? `A monogram built only from the letters "${logoInitials(input.site_name)}": interlocked or carved letterforms with intentional negative space, not plain typed letters. No other text.`
      : "A pictorial or abstract symbol with no text, letters or initials.";
  const compose = (business: boolean, descriptionMax: number, about: number | null) =>
    [
      `Design a premium, original vector logo for ${input.site_name}${business && input.business ? `, ${input.business}` : ""}.`,
      about === null ? "" : businessLine(input.about, about),
      direction ? `Founder direction: ${direction.slice(0, descriptionMax)}.` : "",
      modeLine,
      "Make it ownable and specific to this business: one clever idea (a visual pun, a meaningful negative-space reveal or a confident geometric construction), the craft of a top branding studio, not clip art or a generic icon.",
      colors ? `Palette: ${colors}; flat colour, at most three tones.` : "Use one or two confident brand colours that read on both light and dark backgrounds; flat colour.",
      "Transparent background, centred in a square canvas, crisp at favicon size. No mockup, frame, badge border, watermark, gradient mesh or photographic detail.",
    ]
      .filter(Boolean)
      .join(" ");
  const attempts = [
    ...[0, 1, 2, 3, 4].map((level) => compose(true, LOGO_PROMPT_MAX, level)),
    compose(true, LOGO_PROMPT_MAX, null),
    compose(false, LOGO_PROMPT_MAX, null),
    compose(false, 240, null),
  ];
  for (const attempt of attempts) {
    if (attempt.length <= LOGO_RENDER_PROMPT_MAX) return attempt;
  }
  return compose(false, 240, null).slice(0, LOGO_RENDER_PROMPT_MAX);
}

export function siteLogoModelPrompt(input: {
  site_name: string;
  description: string;
  primary?: string;
  accent?: string;
  business?: LogoBusiness | string;
}): string {
  const about = typeof input.business === "object" ? input.business : undefined;
  return iconPrompt({ ...input, business: typeof input.business === "string" ? input.business : undefined, about });
}

function rgbOf(hex: string | undefined): { r: number; g: number; b: number } | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((hex ?? "").trim());
  if (!m) return null;
  const six = m[1]!.length === 3 ? m[1]!.replace(/./g, (c) => c + c) : m[1]!;
  const n = parseInt(six, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export async function readLogoSnapshot(sandbox: SiteSandbox): Promise<LogoSnapshot> {
  const files = await readSandboxFiles(sandbox, [SITE_LOGO_PATH, SITE_FAVICON_PATH, SITE_CONFIG_PATH, SITE_APP_PATH]);
  const byPath = new Map(files.map((file) => [file.path, file.content]));
  return {
    logo: byPath.get(SITE_LOGO_PATH) ?? null,
    favicon: byPath.get(SITE_FAVICON_PATH) ?? null,
    site: byPath.get(SITE_CONFIG_PATH) ?? null,
    app: byPath.get(SITE_APP_PATH) ?? null,
  };
}

function sanitizeLogoSvg(source: string): string | null {
  return sanitizeSvg(source)
    ?.replace(/<style[\s\S]*?<\/style\s*>/gi, "")
    .replace(/\sstyle\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s(href|xlink:href|src)\s*=\s*("|')\s*(?:https?:)?\/\/[^"']*\2/gi, "")
    .replace(/\s(href|xlink:href|src)\s*=\s*(?:https?:)?\/\/[^\s>]*/gi, "")
    .replace(/\s(href|xlink:href|src)\s*=\s*("|')(?!\s*#)[^"']*\2/gi, "")
    .replace(/\s(href|xlink:href|src)\s*=\s*(?!["'#])[^\s>]*/gi, "")
    .replace(/url\(\s*(?:https?:)?\/\/[^)]*\)/gi, "none") ?? null;
}

export const BUILD_LOGO_WAIT_MS = 8_000;

const BUILD_LOGO_LINE = /(?:^|\n)- Logo: ([^\n]{1,300})/g;

export function buildLogoDirection(rawIdea: string): string | null {
  const idea = decodeXmlEntities(rawIdea).replace(/[‘’]/g, "'");
  let answer: string | null = null;
  for (const m of idea.matchAll(BUILD_LOGO_LINE)) answer = m[1]!.trim();
  if (answer) {
    if (/^(no logo|yes|add a logo)\b/i.test(answer)) return null;
    return answer.replace(/^make a logo mark showing\s+/i, "").slice(0, LOGO_PROMPT_MAX) || null;
  }
  const core = ideaCore(idea);
  const sentences = core.split(/(?<=[.!?])\s+/);
  const generic = (sentence: string) => {
    const request = /\b(?:make|draw|design|create|add)\s+(?:(?:the|a|an)\s+)?logo(?:\s+for\s+([^.!?]+))?(?:\s+please)?[.!?]?\s*$/i.exec(sentence);
    return !!request && (!request[1] || !/[;:]|\b(?:with|using|show(?:s|ing)?|featur(?:e|es|ing)|depict(?:s|ing)?|shaped|like|inspired|around|represent(?:s|ing)?)\b/i.test(request[1]));
  };
  const explicit = (sentence: string) => /\b(?:make|draw|design|create)\s+(?:(?:the|a|an)\s+)?logo\b|\blogo\s+(?:of|with|showing|featuring|depicting|as|a|an|is\s+(?:a|an|showing|featuring)|(?:should|must)\s+(?:be|show|feature|depict))\b/i.test(sentence) && !/\b(?:no|don't|do not|never|without)\s+(?:want\s+to\s+)?(?:(?:make|draw|design|use|add|create|want)\s+)?(?:(?:the|a|an)\s+)?logo\b/i.test(sentence);
  const MARK = /\b(?:logos?|logotype|(?:word|letter)\s?mark|mark|monogram|initials|lettering|icon|symbol|emblem|crest|mascot)\b/i;
  const aboutMark = (i: number) => MARK.test(sentences[i]!) || (i > 0 && /\blogos?\b/i.test(sentences[i - 1]!));
  const sentence = sentences.find((sentence, i) => (directedLogoType(sentence) && aboutMark(i)) || (explicit(sentence) && !generic(sentence)));
  if (!sentence) return null;
  return sentence.slice(0, LOGO_PROMPT_MAX) || null;
}

function ideaCore(idea: string): string {
  return idea.split(/\n\s*\n|\bAdditional context:/i)[0]!.replace(/\s+/g, " ").trim();
}

export function buildLogoDescription(idea: string): string {
  const lead = "a distinctive mark a customer would instantly read as this business, drawn from what it is: ";
  return `${lead}${ideaCore(idea).slice(0, LOGO_PROMPT_MAX - lead.length)}`;
}

export async function prepareBuildLogo(
  input: BuildLogoInput,
  deps: Omit<LogoGenerationDeps, "afford">,
  log: (meta: Record<string, unknown>, ok: boolean) => void = logBuildLogo(input),
): Promise<PreparedLogo | { reason: LogoGenerationError }> {
  const startedAt = Date.now();
  const description = buildLogoDescription(input.idea);
  const site_name = input.site_name || LOGO_PLACEHOLDER_NAME;
  const business = ideaCore(input.idea).slice(0, 160) || undefined;
  const direction = buildLogoDirection(input.idea);
  const designed = deps.design
    ? await deps.design({ site_name, business: ideaCore(input.idea).slice(0, 1200) || site_name, direction, primary: input.primary, accent: input.accent }).catch(() => null)
    : null;
  const out = await prepareGeneratedLogo(
    {
      tenant_id: input.tenant_id,
      site_name,
      request: { description },
      ...(business ? { business: { summary: business } } : {}),
      primary: input.primary,
      accent: input.accent,
      design: designed?.spec ?? null,
    },
    { ...deps, afford: async () => "ok" },
  ).catch(() => ({ reason: "generation_failed" as const }));
  const ms = Date.now() - startedAt;
  const design = designed
    ? { design_type: designed.spec.type, design_source: designed.spec.source, design_ms: designed.ms, ...(designed.reason ? { design_reason: designed.reason.split(":")[0] } : {}) }
    : {};
  if ("reason" in out) log({ skipped_reason: out.reason, ms, ...design }, false);
  else log({ model: out.model, cost_usd: out.cost_usd, ms, ...design }, true);
  return out;
}

function logBuildLogo(input: { tenant_id: string; run_id: string }): (meta: Record<string, unknown>, ok: boolean) => void {
  return (meta, ok) => {
    void import("@/services/logging/logEvent")
      .then(({ logEvent }) =>
        logEvent({ level: ok ? "info" : "warn", source: "site-logo", code: "site_logo.build_generated", tenant_id: input.tenant_id, run_id: input.run_id, meta }),
      )
      .catch(() => undefined);
  };
}

export function liveBuildLogoDeps(): Omit<LogoGenerationDeps, "afford"> {
  return {
    configured: async (task) => (await import("@/services/media-router/router")).isTaskConfiguredWithFallback(task),
    estimate: async (task, req) => {
      const [{ estimateCost, fallbackChain }, { priceUsd }] = await Promise.all([
        import("@/services/media-router/router"),
        import("@/services/media-router/prices"),
      ]);
      const chain = await fallbackChain(task);
      return Math.max(estimateCost(task, req), ...chain.map((route) => priceUsd(route, req, {})));
    },
    generate: async (task, req) => {
      const { generateMediaWithFallback } = await import("@/services/media-router/router");
      const r = await generateMediaWithFallback(task, req, { pollDelayMs: 2_000, maxPolls: 30 });
      return r.ok ? { ok: true, url: r.url, cost_usd: r.cost_usd, model: r.model } : { ok: false, reason: r.reason, error: r.error };
    },
    download: async (url, maxBytes) => (await import("@/services/media-router/router")).downloadMedia(url, maxBytes),
    design: (input) => designSiteLogo(input),
  };
}

export async function prepareGeneratedLogo(
  input: {
    tenant_id: string;
    site_name: string;
    request: LogoRequest;
    primary?: string;
    accent?: string;
    zaviPays?: boolean;
    business?: LogoBusiness;
    design?: LogoDesignSpec | null;
    designLater?: () => Promise<LogoDesignSpec | null>;
  },
  deps: LogoGenerationDeps,
): Promise<PreparedLogo | { reason: LogoGenerationError }> {
  const task = "image.vector" as const;
  if (!(await deps.configured(task).catch(() => false))) return { reason: "not_configured" };
  const businessText = [input.business?.industry, input.business?.summary ?? input.business?.tagline].filter(Boolean).join(": ") || undefined;
  const colors = [rgbOf(input.primary), rgbOf(input.accent)].filter((c): c is { r: number; g: number; b: number } => c !== null);
  const plain = {
    prompt: siteLogoModelPrompt({ ...input, description: input.request.description }),
    aspect_ratio: "1:1" as const,
    ...(colors.length ? { colors } : {}),
  };
  let estimate = 0;
  if (!input.zaviPays) {
    estimate = await deps.estimate(task, plain).catch(() => NaN);
    if (!Number.isFinite(estimate) || estimate <= 0) return { reason: "credits_unavailable" };
    const affordable = await deps.afford(input.tenant_id, estimate).catch(() => "unknown" as const);
    if (affordable === "short") return { reason: "insufficient_credits" };
    if (affordable !== "ok") return { reason: "credits_unavailable" };
  }
  const design = input.design ?? (input.designLater ? await input.designLater().catch(() => null) : null);
  const request = design
    ? { ...plain, prompt: logoRenderPrompt(design, { site_name: input.site_name, business: businessText, primary: input.primary, accent: input.accent }) }
    : plain;
  const generated = await deps.generate(task, request).catch(
    (error: unknown) => ({ ok: false as const, reason: "vendor_error" as MediaFailReason, error: String((error as Error)?.message ?? error) }),
  );
  if (!generated.ok) return { reason: generated.reason === "not_configured" || generated.reason === "out_of_credits" ? "not_configured" : "generation_failed" };
  const bytes = await deps.download(generated.url, MAX_LOGO_BYTES).catch(() => null);
  if (!bytes) return { reason: "download_failed" };
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { reason: "unsafe_svg" };
  }
  const svg = sanitizeLogoSvg(source)?.match(/<svg[\s\S]*<\/svg\s*>/i)?.[0] ?? null;
  if (!svg || !/viewBox\s*=\s*["'][^"']+["']/i.test(svg)) return { reason: "unsafe_svg" };
  return {
    svg: `${svg.trim()}\n`,
    model: generated.model,
    cost_usd: generated.cost_usd,
    charge: { task, cost_usd: generated.model === DEV_STUB_MODEL ? 0 : generated.cost_usd > 0 ? generated.cost_usd : estimate },
    ...(design ? { design } : {}),
  };
}

export function generatedLogoPlan(prepared: Pick<PreparedLogo, "svg">, snapshot: LogoSnapshot): (sandbox: SiteSandbox) => Promise<DirectChangePlan> {
  return async (sandbox) => {
    const current = await readLogoSnapshot(sandbox);
    if (current.logo !== snapshot.logo || current.favicon !== snapshot.favicon || current.site !== snapshot.site || current.app !== snapshot.app) {
      return { reason: "changed" };
    }
    if (!snapshot.app || !siteAppUsesLogo(snapshot.app)) return { reason: "logo_slot_unavailable" };
    const site = snapshot.site ? siteSourceWithLogo(snapshot.site, generatedLogoUrl(prepared.svg)) : null;
    if (!site) return { reason: "logo_slot_unavailable" };
    const files: DirectChangeFile[] = [
      { path: SITE_LOGO_PATH, before: snapshot.logo, after: prepared.svg },
      { path: SITE_FAVICON_PATH, before: snapshot.favicon, after: prepared.svg },
      { path: SITE_CONFIG_PATH, before: snapshot.site, after: site },
    ];
    return { files, label: "Changed the site logo" };
  };
}

export function nameOnlyLogoPlan(snapshot: LogoSnapshot, name: string, opts: { themeCss?: string | null } = {}): (sandbox: SiteSandbox) => Promise<DirectChangePlan> {
  return async (sandbox) => {
    const current = await readLogoSnapshot(sandbox);
    if (current.favicon !== snapshot.favicon || current.site !== snapshot.site || current.app !== snapshot.app) return { reason: "changed" };
    const site = snapshot.site ? siteSourceWithoutLogo(snapshot.site) : null;
    if (!site) return { reason: "logo_slot_unavailable" };
    const themeCss = opts.themeCss ?? (await readSandboxFiles(sandbox, [THEME_CSS_PATH]).catch(() => []))[0]?.content ?? null;
    const favicon = initialsFavicon(name, themeCss);
    if (!favicon) return { reason: "logo_slot_unavailable" };
    const files: DirectChangeFile[] = [
      { path: SITE_FAVICON_PATH, before: snapshot.favicon, after: favicon },
      { path: SITE_CONFIG_PATH, before: snapshot.site, after: site },
    ].filter((f) => f.before !== f.after);
    return { files, label: "Showed the site name without a logo" };
  };
}

export function logoGenerationMessage(reason: string): string {
  if (reason === "insufficient_credits") return "Not enough credits for this logo. Top up to make it. Nothing was run or charged.";
  if (reason === "credits_unavailable") return "We couldn't read your credit balance, so nothing was run or charged. Try again in a minute.";
  if (reason === "not_configured") return "AI logo design is unavailable right now. Try again later.";
  if (reason === "download_failed" || reason === "unsafe_svg") return "That logo wasn't safe to use. Nothing changed or was charged. Try a different description.";
  if (reason === "generation_failed") return "That logo didn't come out. Try again with different words.";
  return "We couldn't save that logo. Nothing was changed. Try again.";
}
