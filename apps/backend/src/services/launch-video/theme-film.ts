import type { FilmContent } from "./theme-film-types";
import { resolveBrandMarks } from "./brand-marks";

export type { FilmContent };

type IntakeFeature = { title?: unknown; detail?: unknown };

const str = (v: unknown, max: number): string =>
  typeof v === "string" ? v.trim().slice(0, max) : "";

function clampDeep(v: unknown, depth: number): unknown {
  if (depth > 6) return undefined;
  if (typeof v === "string") return v.slice(0, 240);
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.slice(0, 40).map((x) => clampDeep(x, depth + 1));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 40)) out[k] = clampDeep(x, depth + 1);
    return out;
  }
  return undefined;
}

export function intakeToFilmContent(
  intake: Record<string, unknown>,
  opts: { theme?: string } = {},
): FilmContent {
  const features = Array.isArray(intake.features)
    ? (intake.features as IntakeFeature[])
        .map((f) => ({ title: str(f?.title, 80), detail: str(f?.detail, 200) }))
        .filter((f) => f.title.length > 0)
        .slice(0, 12)
    : [];

  const metrics = Array.isArray(intake.metrics)
    ? (intake.metrics as { stat?: unknown; label?: unknown }[])
        .map((m) => ({ stat: str(m?.stat, 40), label: str(m?.label, 160) }))
        .filter((m) => m.stat.length > 0)
        .slice(0, 3)
    : [];

  const coverage = intake.coverage as { regions?: unknown } | undefined;
  const regions = Array.isArray(coverage?.regions)
    ? (coverage?.regions as unknown[]).map((r) => str(r, 40)).filter(Boolean).slice(0, 8)
    : [];

  const rawSurface = intake.product_surface as
    | { header?: { title?: unknown }; items?: unknown[] }
    | undefined;
  const surfaceItems = Array.isArray(rawSurface?.items)
    ? (rawSurface?.items as { title?: unknown; chips?: unknown }[])
        .map((item) => ({
          title: str(item?.title, 80),
          chips: Array.isArray(item?.chips)
            ? (item.chips as unknown[]).map((c) => str(c, 40)).filter(Boolean).slice(0, 3)
            : [],
        }))
        .filter((item) => item.title.length > 0)
        .slice(0, 4)
    : [];

  const theme = opts.theme && THEME_NAMES.includes(opts.theme) ? opts.theme : "product_true";

  return {
    product_name: str(intake.product_name, 80) || "This product",
    one_liner: str(intake.one_liner, 200),
    ...(str(intake.problem, 240) ? { problem: str(intake.problem, 240) } : {}),
    ...(surfaceItems.length > 0
      ? {
          surface: {
            title: str(rawSurface?.header?.title, 120) || "What you do with it",
            items: surfaceItems,
          },
        }
      : {}),
    features,
    ...(metrics.length > 0 ? { metrics } : {}),
    ...(regions.length >= 2 ? { regions } : {}),
    ...(() => {
      const marks = resolveBrandMarks([
        features.map((f) => `${f.title} ${f.detail}`).join(" "),
        surfaceItems.map((i) => `${i.title} ${i.chips.join(" ")}`).join(" "),
        str(intake.one_liner, 200),
      ]);
      return marks.length > 0 ? { marks } : {};
    })(),
    ...(theme === "in_use" && intake.in_use && typeof intake.in_use === "object"
      ? { in_use: clampDeep(intake.in_use, 0) as FilmContent["in_use"] }
      : {}),
    ...(theme === "journey" && Array.isArray(intake.journey) && intake.journey.length > 0
      ? {
          journey: (intake.journey as unknown[])
            .filter((x) => x && typeof x === "object" && !Array.isArray(x))
            .slice(0, 30)
            .map((x) => clampDeep(x, 1)) as FilmContent["journey"],
        }
      : {}),
    ...(intake.brand && typeof intake.brand === "object" ? { brand: brandColours(intake.brand as Record<string, unknown>) } : {}),
    cta_text: str(intake.cta_text, 80) || "Get started",
    cta_url: str(intake.cta_url, 300) || str(intake.url, 300),
    theme,
  };
}

const HEX = /^#[0-9a-f]{6}$/i;
function brandColours(b: Record<string, unknown>): NonNullable<FilmContent["brand"]> {
  const pick = (v: unknown) => (typeof v === "string" && HEX.test(v.trim()) ? v.trim() : undefined);
  return { accent: pick(b.accent), ground: pick(b.ground), ink: pick(b.ink) };
}

const THEME_FILMS: Record<string, { module: string; component: string }> = {
  swiss: { module: './themes/swiss-kinetic', component: 'SwissKineticFilm' },
  product_true: { module: './themes/r10/product-true', component: 'ProductTrueFilm' },
  amuse: { module: './themes/amuse/film', component: 'AmuseFilm' },
  in_use: { module: './themes/in-use/film', component: 'InUseFilm' },
  journey: { module: './themes/journey/film', component: 'JourneyFilm' },
};

export const THEME_NAMES = Object.keys(THEME_FILMS);

export function buildThemeFilmSource(content: FilmContent): string {
  const film = THEME_FILMS[content.theme ?? 'swiss'] ?? THEME_FILMS.swiss;
  return [
    "// GENERATED — a theme film filled with this customer's content. Not model-written.",
    "import React from 'react';",
    `import { ${film.component} as Film, filmFrames } from '${film.module}';`,
    "",
    `const content = ${JSON.stringify(content, null, 2)} as const;`,
    "",
    "export const AUTHORED_FRAMES = filmFrames(content);",
    "",
    "export const AuthoredFilm: React.FC = () => <Film content={content} />;",
    "",
  ].join("\n");
}
