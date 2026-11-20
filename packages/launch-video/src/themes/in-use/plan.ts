
export type InUseCard = {
  title: string;
  sub: string;
  tags: string[];
  rows: [string, string][];
  badge?: string;
};

export type InUse = {
  brand?: {
    accent?: string;
    accent_ink?: string;
    ground?: string;
  };
  app_name?: string;
  nav?: string[];
  disclaimer?: string;

  hook: { kicker?: string; headline: string; sub?: string; body?: string; notes?: string[] };

  anchor?: {
    them: { value: string; label: string };
    us: { value: string; label: string };
    source?: string;
    points?: string[];
  };

  find?: {
    title?: string;
    filters: { label: string; options: string[]; pick: string }[];
    button: string;
    notes?: string[];
  };

  catalog?: { title: string; highlight: { label: string; items: string[] } };

  results?: { title: string; noun: string; cards: InUseCard[]; pick: number; action: string };

  thread?: {
    with: string;
    sub?: string;
    messages: { from: 'me' | 'them'; text: string }[];
    notes?: string[];
  };

  booking?: {
    title: string;
    slot_label: string;
    status: { label: string; detail: string }[];
    channels?: string[];
    notes?: string[];
  };

  clocks?: {
    here: { label: string; sub: string; phase: 'morning' | 'evening' };
    there: { label: string; sub: string; phase: 'morning' | 'evening' };
    note: string;
  };

  recurring?: { title: string; note: string; days: string[]; pick_day: number; label: string; rows: string[] };

  pay?: { title: string; methods: string[]; steps: { label: string; detail: string }[] };

  split?: { payer: string; payee: string; keep: string; cut: string; cut_label: string; note: string };

  policy?: {
    title: string;
    window: string;
    before: { label: string; detail: string };
    after: { label: string; detail: string };
    note?: string;
  };

  checklist?: {
    title: string;
    items: string[];
    card?: { title: string; seen: string[]; hidden: string[]; note: string };
  };

  extra?: {
    kicker: string;
    title: string;
    body: string;
    tiles: { title: string; detail: string }[];
    actions?: string[];
    notes?: string[];
    recap?: { title: string; body: string };
  };

  reviews?: { title: string; body: string; empty: string; rules?: string[] };

  supply?: { kicker?: string; title: string; body: string; items: string[]; cta: string };

  steps: { title: string; detail: string }[];

  close: { headline: string; sub?: string; cta: string; url: string; notes?: string[] };
};

export type PlanContent = {
  product_name: string;
  one_liner: string;
  problem?: string;
  surface?: { title: string; items: { title: string; chips: string[] }[] };
  features: { title: string; detail: string }[];
  metrics?: { stat: string; label: string }[];
  cta_text: string;
  cta_url: string;
  in_use?: InUse;
};

export function deriveInUse(c: PlanContent): InUse {
  const items = c.surface?.items ?? [];
  const steps =
    items.length >= 2
      ? items.slice(0, 4).map((i) => ({ title: i.title, detail: i.chips.join(' · ') }))
      : c.features.slice(0, 4).map((f) => ({ title: f.title, detail: f.detail }));
  const m = (c.metrics ?? [])[0];
  return {
    hook: { headline: c.one_liner || c.product_name, kicker: c.product_name, sub: c.problem },
    ...(c.features.length >= 3 ? { checklist: { title: 'What you get', items: c.features.slice(0, 6).map((f) => f.title) } } : {}),
    ...(c.features.length >= 4
      ? {
          extra: {
            kicker: c.product_name,
            title: c.features[0].title,
            body: c.features[0].detail,
            tiles: c.features.slice(1, 5).map((f) => ({ title: f.title, detail: f.detail })),
          },
        }
      : {}),
    ...(m ? { anchor: { them: { value: m.stat, label: m.label }, us: { value: c.product_name, label: c.one_liner } } } : {}),
    steps: steps.length > 0 ? steps : [{ title: c.product_name, detail: c.one_liner }],
    close: { headline: c.one_liner || c.product_name, cta: c.cta_text, url: c.cta_url },
  };
}

export type ShotId =
  | 'hook' | 'anchor' | 'findList' | 'findRuler' | 'findAssemble' | 'catalog'
  | 'results' | 'pick' | 'profile' | 'threadType' | 'threadPhone' | 'book' | 'bookStatus'
  | 'clocks' | 'week' | 'pay' | 'split' | 'policy' | 'checklist' | 'extra' | 'extraRecap'
  | 'reviews' | 'supply' | 'steps' | 'close';

export const SHOT_FRAMES: Record<ShotId, number> = {
  hook: 66, anchor: 60, findList: 54, findRuler: 48, findAssemble: 48, catalog: 66,
  results: 66, pick: 54, profile: 45, threadType: 60, threadPhone: 54, book: 66, bookStatus: 45,
  clocks: 60, week: 66, pay: 54, split: 60, policy: 54, checklist: 54, extra: 66, extraRecap: 48,
  reviews: 45, supply: 54, steps: 60, close: 78,
};

export const MIN_FRAMES = 45 * 30;
export const MAX_SHOT = 102;

export function shotIds(u: InUse): ShotId[] {
  const ids: ShotId[] = ['hook'];
  if (u.anchor) ids.push('anchor');
  const filters = u.find?.filters ?? [];
  if (filters.length > 0) {
    ids.push('findList');
    if (filters.length >= 2) ids.push('findRuler');
    ids.push('findAssemble');
    const total = filters.reduce((s, x) => s + x.options.length, 0);
    if (total >= 12) ids.push('catalog');
  }
  if (u.results && u.results.cards.length >= 2) {
    ids.push('results', 'pick');
    if ((u.results.cards[u.results.pick]?.rows.length ?? 0) >= 3) ids.push('profile');
  }
  if (u.thread && u.thread.messages.length >= 1) {
    ids.push('threadType');
    if (u.thread.messages.length >= 3) ids.push('threadPhone');
  }
  if (u.booking && u.booking.status.length >= 2) ids.push('book', 'bookStatus');
  if (u.clocks) ids.push('clocks');
  if (u.recurring && u.recurring.days.length >= 3) ids.push('week');
  if (u.pay && u.pay.methods.length >= 1) ids.push('pay');
  if (u.split) ids.push('split');
  if (u.policy) ids.push('policy');
  if (u.checklist && u.checklist.items.length >= 3) ids.push('checklist');
  if (u.extra && u.extra.tiles.length >= 2) {
    ids.push('extra');
    if (u.extra.recap) ids.push('extraRecap');
  }
  if (u.reviews) ids.push('reviews');
  if (u.supply) ids.push('supply');
  if (u.steps.length >= 2) ids.push('steps');
  ids.push('close');
  return ids;
}

export function planDurations(ids: ShotId[]): number[] {
  const base = ids.map((id) => SHOT_FRAMES[id]);
  const total = base.reduce((a, b) => a + b, 0);
  if (total >= MIN_FRAMES) return base;
  const k = MIN_FRAMES / total;
  return base.map((d) => Math.min(MAX_SHOT, Math.ceil(d * k)));
}

export const resolveInUse = (c: PlanContent): InUse => c.in_use ?? deriveInUse(c);

export function inUseFrames(c: PlanContent): number {
  return planDurations(shotIds(resolveInUse(c))).reduce((a, b) => a + b, 0);
}
