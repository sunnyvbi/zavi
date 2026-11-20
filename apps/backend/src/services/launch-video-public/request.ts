
import type { PublicLaunchVideoForm } from "./authoring";
import { THEME_NAMES } from "@/services/launch-video/theme-film";

const LIMITS = {
  email: 254,
  product_name: 80,
  company: 120,
  one_liner: 200,
  features: 2000,
  brief: 4000,
  audience: 160,
  cta_text: 80,
  cta_url: 300,
  problem: 240,
  metrics: 200,
  regions: 400,
  screen: 600,
  metric_lines: 3,
  metric_stat: 40,
  metric_label: 160,
  region_count: 8,
  region_label: 40,
} as const;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type GenerateBody = {
  email: string;
  company: string;
  form: PublicLaunchVideoForm;
};

export type ValidateResult =
  | { ok: true; value: GenerateBody }
  | { ok: false; error: string };

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export function validateGenerateBody(raw: unknown): ValidateResult {
  if (!raw || typeof raw !== "object") return { ok: false, error: "invalid_body" };
  const b = raw as Record<string, unknown>;

  const email = str(b.email).toLowerCase();
  if (!email || !EMAIL_RE.test(email)) return { ok: false, error: "invalid_email" };
  if (email.length > LIMITS.email) return { ok: false, error: "email_too_long" };

  const product_name = str(b.product_name);
  const company = str(b.company) || product_name;
  const one_liner = str(b.one_liner);
  const features = str(b.features);
  const audience = str(b.audience);
  const tone = str(b.tone) || "clean";
  const problem = str(b.problem);
  const metrics = str(b.metrics);
  const regions = str(b.regions);
  const screen = str(b.screen);

  const brief = str(b.brief).slice(0, LIMITS.brief);
  const rawGrammar = str(b.grammar);
  const grammar = rawGrammar === "dense" || rawGrammar === "calm" ? rawGrammar : "";

  const rawTheme = str(b.theme);
  const theme = (["swiss", "editorial", "neon"] as const).includes(rawTheme as never)
    ? rawTheme
    : "swiss";
  const rawFilm = str(b.film);
  const film = THEME_NAMES.includes(rawFilm) ? rawFilm : "";
  const cta_text = str(b.cta_text);
  const cta_url = str(b.cta_url);

  if (!product_name) return { ok: false, error: "missing_product_name" };
  if (!one_liner) return { ok: false, error: "missing_one_liner" };
  if (!cta_url) return { ok: false, error: "missing_cta_url" };
  if (!cta_text) return { ok: false, error: "missing_cta_text" };

  const metricLines = metrics.split("\n").filter((l) => l.trim().length > 0);
  if (metricLines.length > LIMITS.metric_lines) return { ok: false, error: "too_many_metrics" };
  for (const line of metricLines) {
    const cut = line.indexOf("|");
    const label = (cut === -1 ? line : line.slice(0, cut)).trim();
    const value = (cut === -1 ? "" : line.slice(cut + 1)).trim();
    if (!label || !value) return { ok: false, error: "metric_line_invalid" };
    if (value.length > LIMITS.metric_stat) return { ok: false, error: "metric_value_too_long" };
    if (label.length > LIMITS.metric_label) return { ok: false, error: "metric_label_too_long" };
  }

  const regionList = regions
    .split(",")
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
  if (regionList.length > LIMITS.region_count) return { ok: false, error: "too_many_regions" };
  if (regionList.length === 1) return { ok: false, error: "too_few_regions" };
  if (regionList.some((r) => r.length > LIMITS.region_label)) return { ok: false, error: "region_too_long" };

  const over =
    product_name.length > LIMITS.product_name ||
    company.length > LIMITS.company ||
    one_liner.length > LIMITS.one_liner ||
    features.length > LIMITS.features ||
    audience.length > LIMITS.audience ||
    cta_text.length > LIMITS.cta_text ||
    cta_url.length > LIMITS.cta_url ||
    problem.length > LIMITS.problem ||
    metrics.length > LIMITS.metrics ||
    regions.length > LIMITS.regions ||
    screen.length > LIMITS.screen;
  if (over) return { ok: false, error: "field_too_long" };

  return {
    ok: true,
    value: {
      email,
      company,
      form: {
        product_name, one_liner, features, audience, tone, theme, problem, metrics, regions,
        screen, cta_text, cta_url, brief, grammar,
        ...(film ? { film } : {}),
      },
    },
  };
}

export function deriveShellSlug(company: string): string {
  const slug = company
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "launch";
}

export function isUpstreamUnavailable(message: unknown): boolean {
  return /\b429\b|\b529\b|rate.?limit|overloaded|unavailable|timeout|ETIMEDOUT|ECONNRESET|socket hang up|llm_error/i.test(
    String(message ?? ""),
  );
}

export function isModerationOutage(reason: unknown): boolean {
  return String(reason ?? "") === "moderation_llm_error";
}
