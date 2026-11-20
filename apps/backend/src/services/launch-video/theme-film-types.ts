
export type FilmContent = {
  product_name: string;
  one_liner: string;
  problem?: string;
  surface?: { title: string; items: { title: string; chips: string[] }[] };
  features: { title: string; detail: string }[];
  metrics?: { stat: string; label: string }[];
  regions?: string[];
  cta_text: string;
  cta_url: string;
  theme?: string;
  marks?: { title: string; src: string; hex: string }[];
  in_use?: InUseLite;
  brand?: { accent?: string; ground?: string; ink?: string };
  journey?: Array<{ kind: string; [k: string]: unknown }>;
};

type InUseLite = {
  anchor?: unknown;
  find?: { filters: { options: string[] }[] };
  results?: { cards: { rows: unknown[] }[]; pick: number };
  thread?: { messages: unknown[] };
  booking?: { status: unknown[] };
  clocks?: unknown;
  recurring?: { days: unknown[] };
  pay?: { methods: unknown[] };
  split?: unknown;
  policy?: unknown;
  checklist?: { items: unknown[] };
  extra?: { tiles: unknown[]; recap?: unknown };
  reviews?: unknown;
  supply?: unknown;
  steps: unknown[];
  [k: string]: unknown;
};

export const JOURNEY_FRAMES = 1530;

export const BEAT = 15;
export const FPS = 30;

const BEATS: Record<string, { hook: number; problem: number; surface: number; wall: number; solo: number; soloMax: number; metrics: number; coverage: number; close: number }> = {
  swiss: { hook: 9, problem: 8, surface: 10, wall: 10, solo: 7, soloMax: 6, metrics: 8, coverage: 7, close: 7 },
  product_true: { hook: 9, problem: 7, surface: 10, wall: 9, solo: 7, soloMax: 6, metrics: 8, coverage: 7, close: 7 },
  amuse: { hook: 9, problem: 8, surface: 10, wall: 9, solo: 7, soloMax: 6, metrics: 8, coverage: 7, close: 7 },
};

const IN_USE_FRAMES: Record<string, number> = {
  hook: 66, anchor: 60, findList: 54, findRuler: 48, findAssemble: 48, catalog: 66,
  results: 66, pick: 54, profile: 45, threadType: 60, threadPhone: 54, book: 66, bookStatus: 45,
  clocks: 60, week: 66, pay: 54, split: 60, policy: 54, checklist: 54, extra: 66, extraRecap: 48,
  reviews: 45, supply: 54, steps: 60, close: 78,
};

function deriveInUseLite(c: FilmContent): InUseLite {
  const items = c.surface?.items ?? [];
  const steps = items.length >= 2 ? items.slice(0, 4) : c.features.slice(0, 4);
  return {
    ...(c.features.length >= 3 ? { checklist: { items: c.features.slice(0, 6) } } : {}),
    ...(c.features.length >= 4 ? { extra: { tiles: c.features.slice(1, 5) } } : {}),
    ...((c.metrics ?? [])[0] ? { anchor: true } : {}),
    steps: steps.length > 0 ? steps : [c.product_name],
  };
}

export function inUseShotIds(u: InUseLite): string[] {
  const ids = ["hook"];
  if (u.anchor) ids.push("anchor");
  const filters = u.find?.filters ?? [];
  if (filters.length > 0) {
    ids.push("findList");
    if (filters.length >= 2) ids.push("findRuler");
    ids.push("findAssemble");
    if (filters.reduce((s, x) => s + x.options.length, 0) >= 12) ids.push("catalog");
  }
  if (u.results && u.results.cards.length >= 2) {
    ids.push("results", "pick");
    if ((u.results.cards[u.results.pick]?.rows.length ?? 0) >= 3) ids.push("profile");
  }
  if (u.thread && u.thread.messages.length >= 1) {
    ids.push("threadType");
    if (u.thread.messages.length >= 3) ids.push("threadPhone");
  }
  if (u.booking && u.booking.status.length >= 2) ids.push("book", "bookStatus");
  if (u.clocks) ids.push("clocks");
  if (u.recurring && u.recurring.days.length >= 3) ids.push("week");
  if (u.pay && u.pay.methods.length >= 1) ids.push("pay");
  if (u.split) ids.push("split");
  if (u.policy) ids.push("policy");
  if (u.checklist && u.checklist.items.length >= 3) ids.push("checklist");
  if (u.extra && u.extra.tiles.length >= 2) {
    ids.push("extra");
    if (u.extra.recap) ids.push("extraRecap");
  }
  if (u.reviews) ids.push("reviews");
  if (u.supply) ids.push("supply");
  if (u.steps.length >= 2) ids.push("steps");
  ids.push("close");
  return ids;
}

export function inUseFrames(c: FilmContent): number {
  const base = inUseShotIds(c.in_use ?? deriveInUseLite(c)).map((id) => IN_USE_FRAMES[id]);
  const total = base.reduce((a, b) => a + b, 0);
  const floor = 45 * FPS;
  if (total >= floor) return total;
  const k = floor / total;
  return base.map((d) => Math.min(102, Math.ceil(d * k))).reduce((a, b) => a + b, 0);
}

export function filmFrames(c: FilmContent): number {
  if (c.theme === "in_use") return inUseFrames(c);
  if (c.theme === "journey") return JOURNEY_FRAMES;
  const b = BEATS[c.theme ?? "swiss"] ?? BEATS.swiss;
  let frames = BEAT * b.hook;
  if (c.problem) frames += BEAT * b.problem;
  if (c.surface && c.surface.items.length > 0) frames += BEAT * b.surface;
  if (c.features.length >= 3) frames += BEAT * b.wall;
  frames += Math.min(c.features.length, b.soloMax) * BEAT * b.solo;
  if ((c.metrics ?? []).length > 0) frames += BEAT * b.metrics;
  if ((c.regions ?? []).length >= 2) frames += BEAT * b.coverage;
  frames += BEAT * b.close;
  const floor = 45 * FPS;
  if (frames < floor) {
    const shots = shotCount(c);
    frames += Math.ceil((floor - frames) / BEAT / shots) * BEAT * shots;
  }
  return frames;
}

function shotCount(c: FilmContent): number {
  const b = BEATS[c.theme ?? "swiss"] ?? BEATS.swiss;
  let n = 1;
  if (c.problem) n += 1;
  if (c.surface && c.surface.items.length > 0) n += 1;
  if (c.features.length >= 3) n += 1;
  n += Math.min(c.features.length, b.soloMax);
  if ((c.metrics ?? []).length > 0) n += 1;
  if ((c.regions ?? []).length >= 2) n += 1;
  return n + 1;
}

export const filmSeconds = (c: FilmContent): number => filmFrames(c) / FPS;
