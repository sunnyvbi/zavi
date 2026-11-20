
import type { LaunchVideoScene } from "@/services/launch-video/brief-mapper";

export const FPS = 30;
export const TARGET_SECONDS = 45;

export const CALM_MIN_SECONDS = 75;

export const MAX_FEATURES = 12;

const SCENE_SECONDS: Record<string, number> = {
  hook: 5.5,
  problem: 5.5,
  productui: 7.0,
  cardwall: 7.0,
  feature: 6.0,
  metric: 6.5,
  coverage: 6.0,
  proof: 5.5,
  cta: 5.0,
};

export type ComposeFeature = { title: string; detail: string; glyph?: string };
export type ComposeMetric = { stat: string; label: string };

export type ComposeInput = {
  product_name: string;
  one_liner: string;
  problem?: string;
  features: ComposeFeature[];
  product_surface?: { header: { title: string; search_placeholder?: string }; items: Array<{ title: string; chips: string[]; glyph?: string }> };
  metrics?: ComposeMetric[];
  proof?: { stat: string; label: string };
  coverage?: { headline?: string; regions: string[] };
  cta_text: string;
  cta_url: string;
};

export type MissingItem = { field: string; label: string; seconds: number };

export type ComposePlan = {
  scenes: LaunchVideoScene[];
  seconds: number;
  meets_target: boolean;
  missing: MissingItem[];
};

const frames = (kind: string): number => Math.round((SCENE_SECONDS[kind] ?? 5.5) * FPS);

const WALL_CARDS = 3;

export function composePublicVideo(input: ComposeInput): ComposePlan {
  const scenes: LaunchVideoScene[] = [];
  const push = (s: LaunchVideoScene) => scenes.push(s);

  const features = input.features ?? [];
  const wall = features.slice(0, WALL_CARDS);
  const solo = features.slice(WALL_CARDS);

  push({ kind: "hook", headline: input.one_liner, sub: `Meet ${input.product_name}.` });

  if (input.problem) push({ kind: "problem", headline: input.problem });

  if (input.product_surface) {
    push({ kind: "productui", header: input.product_surface.header, items: input.product_surface.items.slice(0, 4) });
  }

  if (wall.length > 0) {
    push({ kind: "cardwall", cards: wall.map((f) => ({ title: f.title, detail: f.detail })) });
  }

  const setPieces: LaunchVideoScene[] = [];
  if (input.metrics && input.metrics.length > 0) setPieces.push({ kind: "metric", metrics: input.metrics.slice(0, 3) });
  if (input.coverage && input.coverage.regions.length >= 2)
    setPieces.push({
      kind: "coverage",
      ...(input.coverage.headline ? { headline: input.coverage.headline } : {}),
      regions: input.coverage.regions.slice(0, 8),
    });
  if (input.proof) setPieces.push({ kind: "proof", stat: input.proof.stat, stat_label: input.proof.label });

  const step = setPieces.length > 0 ? Math.max(1, Math.ceil(solo.length / (setPieces.length + 1))) : 0;
  let si = 0;
  for (let i = 0; i < solo.length; i++) {
    const f = solo[i];
    if (f) push({ kind: "feature", headline: f.title, sub: f.detail, ...(f.glyph ? { glyph: f.glyph } : {}) });
    const next = setPieces[si];
    if (next && step > 0 && (i + 1) % step === 0) {
      push(next);
      si++;
    }
  }
  for (; si < setPieces.length; si++) {
    const sp = setPieces[si];
    if (sp) push(sp);
  }

  push({ kind: "cta", headline: input.cta_text });

  const withDurations = scenes.map((s) => ({ ...s, duration_frames: frames(s.kind) }));
  const totalFrames = withDurations.reduce((sum, s) => sum + (s.duration_frames ?? 0), 0);
  const seconds = Math.round((totalFrames / FPS) * 10) / 10;

  return {
    scenes: withDurations as LaunchVideoScene[],
    seconds,
    meets_target: seconds >= TARGET_SECONDS,
    missing: seconds >= TARGET_SECONDS ? [] : shortfall(input, seconds),
  };
}

function shortfall(input: ComposeInput, seconds: number): MissingItem[] {
  const out: MissingItem[] = [];
  let gap = TARGET_SECONDS - seconds;

  const offer = (field: string, label: string, secs: number) => {
    if (gap <= 0) return;
    out.push({ field, label, seconds: secs });
    gap -= secs;
  };

  if (!input.problem) offer("problem", "What is broken today, in one line", SCENE_SECONDS.problem ?? 5.5);
  if (!input.product_surface) offer("product_surface", "What someone actually does with it, in one sentence", SCENE_SECONDS.productui ?? 7);
  if (!input.metrics || input.metrics.length === 0) offer("metrics", "Real numbers, up to 3, each as Label|Value", SCENE_SECONDS.metric ?? 6.5);
  if (!input.coverage || input.coverage.regions.length < 2) offer("coverage", "Where you operate, two places or more", SCENE_SECONDS.coverage ?? 6);

  if (gap > 0) {
    const per = SCENE_SECONDS.feature ?? 6;
    const supplied = input.features?.length ?? 0;
    const absorbedByWall = Math.max(0, WALL_CARDS - supplied);
    const earning = Math.ceil(gap / per);
    const room = Math.max(0, MAX_FEATURES - supplied);
    const more = Math.min(absorbedByWall + earning, room);
    if (more > 0) {
      const buys = Math.max(0, more - absorbedByWall) * per;
      out.push({
        field: "features",
        label: `${more} more under What should it show off, one per line`,
        seconds: buys,
      });
    }
  }
  return out;
}
