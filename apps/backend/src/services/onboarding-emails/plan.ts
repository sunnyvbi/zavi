
export const MIN_GAP_MS = 20 * 3_600_000;
export const WAIT_CAP_MS = 24 * 3_600_000;
export const RECHECK_MS = 3_600_000;
const DAY_MS = 86_400_000;

export const WELCOME = 1;
export const GROWTH_STRATEGY = 2;
export const DIGEST = 10;
export const CREATORS = 8;
export const PAID_ADS = 9;
export const CHANNEL_STEPS = [3, 4, 6, 7] as const;
export type ChannelStep = (typeof CHANNEL_STEPS)[number];
export type ResultsStep = ChannelStep | typeof CREATORS;

export const CHANNELS_FOR_STEP: Readonly<Record<ResultsStep, readonly string[]>> = {
  3: ["seo", "geo"],
  4: ["linkedin_organic", "x_organic"],
  6: ["reddit_organic"],
  7: ["instagram_organic"],
  8: ["ugc", "generated_video"],
};

export type PlanRow = {
  started_at: string;
  last_step: number;
  last_sent_at: string | null;
  sent_steps: readonly number[];
  skipped_steps: readonly number[];
  channel_order: readonly number[] | null;
  wait_since: string | null;
  digest_until: string | null;
};

export type PlanFacts = {
  openCards: ReadonlyMap<string, number>;
  used: ReadonlySet<string>;
  inFlight: ReadonlySet<string>;
  upgradeEmailSent: boolean;
  paidRerunsInFlight: boolean;
};

export type Variant = "intro" | "results" | "digest";

export type PlanDecision =
  | {
      kind: "send";
      step: number;
      variant: Variant;
      skip: number[];
      channelOrder: number[] | null;
      nextDue: Date | null;
    }
  | { kind: "wait"; until: Date; stampWait: boolean }
  | { kind: "over"; skip: number[] };

export function isLegacyRow(row: Pick<PlanRow, "sent_steps" | "skipped_steps">): boolean {
  return row.sent_steps.includes(GROWTH_STRATEGY) && !row.sent_steps.includes(DIGEST) && !row.skipped_steps.includes(DIGEST);
}

export function doneSteps(row: Pick<PlanRow, "last_step" | "sent_steps" | "skipped_steps">): Set<number> {
  const done = new Set<number>([...row.sent_steps, ...row.skipped_steps]);
  if (row.last_step >= WELCOME) done.add(WELCOME);
  return done;
}

const cardsFor = (facts: PlanFacts, slugs: readonly string[]) =>
  slugs.reduce((n, s) => n + (facts.inFlight.has(s) ? 0 : (facts.openCards.get(s) ?? 0)), 0);
const totalCards = (facts: PlanFacts) => [...facts.openCards.values()].reduce((n, c) => n + c, 0);
export function openCardsForStep(facts: PlanFacts, step: ResultsStep): number {
  return CHANNELS_FOR_STEP[step].reduce((n, s) => n + (facts.openCards.get(s) ?? 0), 0);
}

export function channelOrderFor(facts: PlanFacts): number[] {
  return [...CHANNEL_STEPS]
    .map((step, i) => ({ step, i, n: cardsFor(facts, CHANNELS_FOR_STEP[step]) }))
    .sort((a, b) => b.n - a.n || a.i - b.i)
    .map((x) => x.step);
}

function usedAll(facts: PlanFacts, step: ResultsStep): boolean {
  return CHANNELS_FOR_STEP[step].every((s) => facts.used.has(s));
}

function waitOrFallback(row: PlanRow, now: Date): PlanDecision | null {
  const since = row.wait_since ? Date.parse(row.wait_since) : NaN;
  if (Number.isFinite(since) && now.getTime() - since >= WAIT_CAP_MS) return null;
  return { kind: "wait", until: new Date(now.getTime() + RECHECK_MS), stampWait: true };
}

function orderFor(row: PlanRow, facts: PlanFacts): { order: number[]; decided: boolean } {
  const stored = (row.channel_order ?? []).filter((s) => (CHANNEL_STEPS as readonly number[]).includes(s));
  if (stored.length > 0) {
    return { order: [...stored, ...CHANNEL_STEPS.filter((s) => !stored.includes(s))], decided: false };
  }
  return { order: channelOrderFor(facts), decided: true };
}

function nextDueAfter(row: PlanRow, sentCount: number, now: Date): Date {
  return new Date(Math.max(Date.parse(row.started_at) + sentCount * DAY_MS, now.getTime() + MIN_GAP_MS));
}

function anythingLeft(row: PlanRow, done: ReadonlySet<number>, now: Date, legacyDigestOpen: boolean): boolean {
  if (!done.has(WELCOME)) return true;
  if (!done.has(GROWTH_STRATEGY) && !done.has(DIGEST)) return true;
  if ([...CHANNEL_STEPS, CREATORS, PAID_ADS].some((s) => !done.has(s))) return true;
  return legacyDigestOpen && !done.has(DIGEST) && digestStillOpen(row, now);
}

function digestStillOpen(row: Pick<PlanRow, "digest_until">, now: Date): boolean {
  const until = row.digest_until ? Date.parse(row.digest_until) : NaN;
  return Number.isFinite(until) && now.getTime() < until;
}

export function planNext(row: PlanRow, facts: PlanFacts | null, now: Date): PlanDecision {
  const lastSent = row.last_sent_at ? Date.parse(row.last_sent_at) : NaN;
  if (Number.isFinite(lastSent) && now.getTime() < lastSent + MIN_GAP_MS) {
    return { kind: "wait", until: new Date(lastSent + MIN_GAP_MS), stampWait: false };
  }
  const done = doneSteps(row);
  const f: PlanFacts = facts ?? {
    openCards: new Map(),
    used: new Set(),
    inFlight: new Set(),
    upgradeEmailSent: false,
    paidRerunsInFlight: false,
  };
  const noDigest = f.upgradeEmailSent === true && !done.has(DIGEST);
  const legacy = isLegacyRow(row) && !noDigest;
  const digestSkip = noDigest && done.has(GROWTH_STRATEGY) ? [DIGEST] : [];

  const send = (step: number, variant: Variant, skip: number[], channelOrder: number[] | null): PlanDecision => {
    const after = new Set([...done, step, ...skip]);
    const sentCount = new Set([...row.sent_steps, ...(row.last_step >= WELCOME ? [WELCOME] : []), step]).size;
    const legacyAfter = legacy && step !== DIGEST;
    return {
      kind: "send",
      step,
      variant,
      skip,
      channelOrder,
      nextDue: anythingLeft(row, after, now, legacyAfter) ? nextDueAfter(row, sentCount, now) : null,
    };
  };

  if (!done.has(WELCOME)) return send(WELCOME, "intro", [], null);

  if (legacy && digestStillOpen(row, now)) {
    if (!f.paidRerunsInFlight && totalCards(f) > 0) return send(DIGEST, "digest", [], null);
    if (f.inFlight.size > 0) {
      const w = waitOrFallback(row, now);
      if (w) return w;
    }
  }

  if (!done.has(GROWTH_STRATEGY) && !done.has(DIGEST)) {
    if (noDigest) return send(GROWTH_STRATEGY, "intro", [DIGEST], null);
    if (f.paidRerunsInFlight) {
      const w = waitOrFallback(row, now);
      if (w) return w;
      return send(GROWTH_STRATEGY, "intro", [DIGEST], null);
    }
    if (totalCards(f) > 0) return send(DIGEST, "digest", [GROWTH_STRATEGY], null);
    if (f.inFlight.size > 0) {
      const w = waitOrFallback(row, now);
      if (w) return w;
    }
    return send(GROWTH_STRATEGY, "intro", [DIGEST], null);
  }

  const { order, decided } = orderFor(row, f);
  const skips: number[] = [...digestSkip];
  for (const s of order as ChannelStep[]) {
    if (done.has(s)) continue;
    if (usedAll(f, s)) {
      skips.push(s);
      continue;
    }
    const orderToStore = decided ? order : null;
    if (openCardsForStep(f, s) > 0) return send(s, "results", skips, orderToStore);
    if (CHANNELS_FOR_STEP[s].some((c) => f.inFlight.has(c))) {
      const w = waitOrFallback(row, now);
      if (w) return w;
    }
    return send(s, "intro", skips, orderToStore);
  }

  if (!done.has(CREATORS)) {
    if (usedAll(f, CREATORS)) skips.push(CREATORS);
    else {
      if (openCardsForStep(f, CREATORS) > 0) return send(CREATORS, "results", skips, null);
      if (CHANNELS_FOR_STEP[CREATORS].some((c) => f.inFlight.has(c))) {
        const w = waitOrFallback(row, now);
        if (w) return w;
      }
      return send(CREATORS, "intro", skips, null);
    }
  }
  if (!done.has(PAID_ADS)) return send(PAID_ADS, "intro", skips, null);

  if (legacy && digestStillOpen(row, now)) {
    const until = Math.min(now.getTime() + RECHECK_MS, Date.parse(row.digest_until as string));
    return { kind: "wait", until: new Date(until), stampWait: false };
  }
  return { kind: "over", skip: skips };
}

export function needsFacts(row: PlanRow, now: Date): boolean {
  const lastSent = row.last_sent_at ? Date.parse(row.last_sent_at) : NaN;
  if (Number.isFinite(lastSent) && now.getTime() < lastSent + MIN_GAP_MS) return false;
  return doneSteps(row).has(WELCOME);
}
