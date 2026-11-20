
import { inngest } from "@/../workers/client";
import { reserveCardBudget, releaseCardBudget } from "./budget";
import {
  attachQueueRowToCard,
  claimCard,
  findRecentCardForDomain,
  listCardsAwaitingEmail,
  listConfirmedQueueRows,
  purgeStaleQueueRows,
  updateCard,
  type QueueRow,
} from "./store";
import { cancelCard, sendQueuedCardEmails } from "./pipeline";
import type { StartCardLocale } from "@zavi/shared";

export const QUEUE_RETENTION_DAYS = 7;
const DRAIN_BATCH = 25;
export const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

export function retentionCutoffIso(now: Date = new Date()): string {
  return new Date(now.getTime() - QUEUE_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

export function startCardEventId(cardId: string): string {
  return `start-card-${cardId}`;
}

export async function enqueueCardRun(cardId: string): Promise<void> {
  await inngest.send({ name: "start-card/requested", id: startCardEventId(cardId), data: { card_id: cardId } });
}

export type CardStartDeps = {
  claim: typeof claimCard;
  enqueue: (cardId: string) => Promise<void>;
  release: typeof releaseCardBudget;
  fail: typeof cancelCard;
  locate?: (cardId: string, locale: StartCardLocale) => Promise<void>;
};

export type StartedCard = { id: string; public_id: string; reused: boolean };

export async function createAndStartCard(
  input: { domain: string; ip_hash: string | null; referrer_card_id: string | null; visitor_country?: StartCardLocale | null },
  reservation: { day: string; amount: number },
  deps: CardStartDeps = { claim: claimCard, enqueue: enqueueCardRun, release: releaseCardBudget, fail: cancelCard },
  now: Date = new Date(),
): Promise<StartedCard> {
  let claimed: { outcome: "created" | "reused"; id: string; public_id: string };
  try {
    const r = await deps.claim({
      domain: input.domain,
      since_iso: new Date(now.getTime() - DEDUPE_WINDOW_MS).toISOString(),
      funding: {
        kind: "public_budget",
        budget_day: reservation.day,
        reserved_usd: reservation.amount,
        ip_hash: input.ip_hash,
        referrer_card_id: input.referrer_card_id,
      },
    });
    if (r.outcome !== "created" && r.outcome !== "reused") {
      throw new Error(`start_card_claim: unexpected outcome ${r.outcome} for a public card`);
    }
    claimed = { outcome: r.outcome, id: r.id, public_id: r.public_id };
  } catch (e) {
    await deps.release(reservation.day, reservation.amount);
    throw e;
  }
  if (claimed.outcome === "reused") {
    await deps.release(reservation.day, reservation.amount);
    return { id: claimed.id, public_id: claimed.public_id, reused: true };
  }
  if (input.visitor_country) {
    const locate = deps.locate ?? ((id: string, locale: StartCardLocale) => updateCard(id, { locale }));
    await locate(claimed.id, input.visitor_country).catch(() => undefined);
  }
  try {
    await deps.enqueue(claimed.id);
  } catch (e) {
    await deps.fail(claimed.id, "enqueue_failed");
    throw e;
  }
  return { id: claimed.id, public_id: claimed.public_id, reused: false };
}

export type DrainDeps = {
  listConfirmed: (limit: number) => Promise<QueueRow[]>;
  listAwaitingEmail: (limit: number) => Promise<string[]>;
  findRecent: typeof findRecentCardForDomain;
  reserve: typeof reserveCardBudget;
  start: (
    input: { domain: string; ip_hash: string | null; referrer_card_id: string | null },
    reservation: { day: string; amount: number },
  ) => Promise<StartedCard>;
  attach: typeof attachQueueRowToCard;
  sendForCard: (cardId: string) => Promise<unknown>;
  purge: (beforeIso: string) => Promise<number>;
};

const defaultDeps: DrainDeps = {
  listConfirmed: listConfirmedQueueRows,
  listAwaitingEmail: listCardsAwaitingEmail,
  findRecent: findRecentCardForDomain,
  reserve: reserveCardBudget,
  start: (input, reservation) => createAndStartCard(input, reservation),
  attach: attachQueueRowToCard,
  sendForCard: sendQueuedCardEmails,
  purge: purgeStaleQueueRows,
};

export type DrainResult = { purged: number; started: number; reused: number; stopped: "empty" | "budget" | "error" };

export async function drainQueue(now: Date = new Date(), deps: DrainDeps = defaultDeps): Promise<DrainResult> {
  const purged = await deps.purge(retentionCutoffIso(now));
  for (const cardId of await deps.listAwaitingEmail(DRAIN_BATCH)) await deps.sendForCard(cardId);
  const rows = await deps.listConfirmed(DRAIN_BATCH);
  let started = 0;
  let reused = 0;
  for (const row of rows) {
    const recent = await deps.findRecent(row.domain, new Date(now.getTime() - DEDUPE_WINDOW_MS).toISOString());
    if (recent) {
      await deps.attach(row.id, recent.id);
      await deps.sendForCard(recent.id);
      reused++;
      continue;
    }
    const reservation = await deps.reserve(now);
    if (!reservation.ok) return { purged, started, reused, stopped: reservation.reason === "full" ? "budget" : "error" };
    const card = await deps.start({ domain: row.domain, ip_hash: row.ip_hash, referrer_card_id: null }, reservation);
    await deps.attach(row.id, card.id);
    await deps.sendForCard(card.id);
    if (card.reused) reused++;
    else started++;
  }
  return { purged, started, reused, stopped: "empty" };
}
