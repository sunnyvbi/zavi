import type Stripe from "stripe";
import { affiliateRpc, globalClient } from "@/services/tenant-client";

export const MIN_PAYOUT_CENTS = 2000;
const PAGE = 500;
const KEY_SAFE_MS = 23 * 3600_000;
const RECONCILE_AFTER_MS = 3600_000;

type OpenPayout = {
  id: string; member_id: string; amount_cents: number; state: string; updated_at: string;
  first_attempt_at?: string | null; destination_account?: string | null;
};

export type PayoutDeps = {
  enabled: () => Promise<boolean>;
  stripe: () => Stripe;
  livemode: boolean;
  membersToVisit: (livemode: boolean, after: string, limit: number) => Promise<string[]>;
  start: (payoutId: string, destination: string, now: Date) => Promise<{ outcome: string; amount_cents?: number }>;
  payoutAccount: (memberId: string) => Promise<{ stripe_account_id: string; disabled_reason: string | null } | null>;
  approved: (memberId: string) => Promise<boolean>;
  transfersActive: (account: Stripe.Account) => boolean;
  claim: (memberId: string, livemode: boolean, now: Date) => Promise<{ outcome: string; payout_id?: string; amount_cents?: number }>;
  move: (payoutId: string, from: string, to: string, transferId?: string | null, error?: string | null) => Promise<string>;
  openPayouts: (livemode: boolean, states: string[], after: string, limit: number) => Promise<OpenPayout[]>;
  reversalClaim: (memberId: string, livemode: boolean) => Promise<{ outcome: string; reversal_id?: string; transfer_id?: string | null; amount_cents?: number; state?: string; attempted_at?: string | null }>;
  reversalMove: (id: string, from: string, to: string, stripeId?: string | null, error?: string | null) => Promise<string>;
  reversalStart: (id: string) => Promise<{ outcome: string; amount_cents?: number }>;
  purgeClicks: (olderThan: Date) => Promise<number>;
  drainInbox: () => Promise<number>;
  alert: (message: string) => Promise<void>;
  log: (message: string) => void;
  now: () => Date;
};

export type PayoutRunSummary = {
  disabled?: true;
  sent: number;
  awaiting_approval: number;
  waiting: number;
  failed: number;
  reconcile: number;
  reversed: number;
  errors: number;
};

const group = (payoutId: string) => `affiliate_${payoutId}`;
const key = (payoutId: string) => `affiliate-payout-${payoutId}`;
const msg = (e: unknown) => ((e as Error)?.message ?? "error").slice(0, 200);

export function definitelyNotSent(e: unknown): boolean {
  const code = Number((e as { statusCode?: unknown })?.statusCode);
  return Number.isFinite(code) && code >= 400 && code < 500 && code !== 409 && code !== 429;
}

async function availableUsd(stripe: Stripe): Promise<number> {
  const b = await stripe.balance.retrieve();
  return (b.available ?? []).filter((x) => x.currency === "usd").reduce((s, x) => s + x.amount, 0);
}

async function createTransfer(p: OpenPayout, destination: string, d: PayoutDeps) {
  return d.stripe().transfers.create(
    {
      amount: p.amount_cents,
      currency: "usd",
      destination,
      transfer_group: group(p.id),
      description: "Zavi affiliate commissions",
      metadata: { zavi_purpose: "affiliate_payout", affiliate_payout_id: p.id },
    },
    { idempotencyKey: key(p.id) },
  );
}

async function settleInFlight(p: OpenPayout, d: PayoutDeps, sum: PayoutRunSummary): Promise<void> {
  const from = p.state;
  const found = await d.stripe().transfers.list({ transfer_group: group(p.id), limit: 1 });
  if (found.data[0]) {
    await d.move(p.id, from, "sent", found.data[0].id);
    sum.sent++;
    return;
  }
  const since = p.first_attempt_at ?? p.updated_at;
  if (d.now().getTime() - new Date(since).getTime() > KEY_SAFE_MS) {
    if (from === "transferring") await d.move(p.id, "transferring", "reconcile", null, "past the idempotency window; a person must check Stripe");
    await d.alert(`Affiliate payout ${p.id} is unsettled and past Stripe's 24-hour idempotency window: check Stripe, then record or release it.`);
    sum.reconcile++;
    return;
  }
  if (!(await d.approved(p.member_id))) {
    if (from === "transferring") await d.move(p.id, "transferring", "reconcile", null, "creator no longer approved");
    await d.alert(`Affiliate payout ${p.id} is unsettled and its creator is no longer approved: a person must decide.`);
    sum.reconcile++;
    return;
  }
  const destination = p.destination_account;
  if (!destination) {
    await d.alert(`Affiliate payout ${p.id} is ${from} with no recorded destination; a person must decide.`);
    sum.reconcile++;
    return;
  }
  try {
    const t = await createTransfer(p, destination, d);
    await d.move(p.id, from, "sent", t.id);
    sum.sent++;
  } catch (e) {
    if (definitelyNotSent(e)) {
      await d.move(p.id, from, "failed", null, msg(e));
      sum.failed++;
    } else {
      if (from === "transferring") await d.move(p.id, "transferring", "reconcile", null, msg(e));
      sum.reconcile++;
    }
  }
}

async function send(p: OpenPayout, d: PayoutDeps, sum: PayoutRunSummary): Promise<void> {
  const acct = await d.payoutAccount(p.member_id);
  if (!acct || acct.disabled_reason) {
    sum.waiting++;
    return;
  }
  const live = await d.stripe().accounts.retrieve(acct.stripe_account_id);
  if (!d.transfersActive(live)) {
    sum.waiting++;
    return;
  }
  if ((await availableUsd(d.stripe())) < p.amount_cents) {
    sum.waiting++;
    await d.alert(`Affiliate payout ${p.id} ($${(p.amount_cents / 100).toFixed(2)}) is waiting: the Stripe available balance is too low. It is tried again tomorrow.`);
    return;
  }
  const started = await d.start(p.id, acct.stripe_account_id, d.now());
  if (started.outcome !== "transferring" || !started.amount_cents) {
    if (started.outcome === "cancelled") sum.waiting++;
    return;
  }
  const amount = started.amount_cents;
  try {
    const t = await createTransfer({ ...p, amount_cents: amount }, acct.stripe_account_id, d);
    await d.move(p.id, "transferring", "sent", t.id);
    sum.sent++;
  } catch (e) {
    if (definitelyNotSent(e)) {
      await d.move(p.id, "transferring", "failed", null, msg(e));
      sum.failed++;
    } else {
      await d.move(p.id, "transferring", "reconcile", null, msg(e));
      sum.reconcile++;
      await d.alert(`Affiliate payout ${p.id}: the transfer outcome is unclear (${msg(e)}). It is settled on the next run with the same idempotency key.`);
    }
  }
}

async function findReversal(transferId: string, reversalId: string, d: PayoutDeps): Promise<string | null> {
  for await (const x of d.stripe().transfers.listReversals(transferId, { limit: 100 })) {
    if (x.metadata?.affiliate_reversal_id === reversalId) return x.id;
  }
  return null;
}

async function reverse(memberId: string, d: PayoutDeps, sum: PayoutRunSummary): Promise<void> {
  const r = await d.reversalClaim(memberId, d.livemode);
  if (!r.reversal_id || !r.amount_cents || !r.transfer_id) return;
  const id = r.reversal_id;
  let amount = r.amount_cents;
  if (r.state === "reconcile") {
    const found = await findReversal(r.transfer_id, id, d);
    if (found) {
      await d.reversalMove(id, "reconcile", "sent", found);
      sum.reversed++;
      return;
    }
    if (r.attempted_at && d.now().getTime() - new Date(r.attempted_at).getTime() > RECONCILE_AFTER_MS) {
      await d.reversalMove(id, "reconcile", "failed", null, "not in Stripe an hour after the attempt");
    }
    return;
  } else {
    const started = await d.reversalStart(id);
    if (started.outcome !== "reconcile" || !started.amount_cents) return;
    amount = started.amount_cents;
  }
  try {
    const rev = await d.stripe().transfers.createReversal(
      r.transfer_id,
      { amount, metadata: { zavi_purpose: "affiliate_reversal", affiliate_reversal_id: id } },
      { idempotencyKey: `affiliate-reversal-${id}` },
    );
    await d.reversalMove(id, "reconcile", "sent", rev.id);
    sum.reversed++;
  } catch (e) {
    if (definitelyNotSent(e)) {
      await d.reversalMove(id, "reconcile", "failed", null, msg(e));
      d.log(`[affiliates] reversal ${id} refused: ${msg(e)}; the debt nets against future commissions`);
    }
  }
}

async function eachPage<T>(fetch: (after: string) => Promise<T[]>, keyOf: (t: T) => string, visit: (t: T) => Promise<void>): Promise<void> {
  let after = "";
  for (;;) {
    const rows = await fetch(after);
    for (const r of rows) await visit(r);
    if (rows.length < PAGE) return;
    after = keyOf(rows[rows.length - 1]);
  }
}

export async function runAffiliatePayouts(d: PayoutDeps): Promise<PayoutRunSummary> {
  const sum: PayoutRunSummary = { sent: 0, awaiting_approval: 0, waiting: 0, failed: 0, reconcile: 0, reversed: 0, errors: 0 };
  const now = d.now();
  const guarded = async (what: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      sum.errors++;
      d.log(`[affiliates] ${what} failed: ${msg(e)}`);
    }
  };
  await guarded("drain inbox", async () => {
    await d.drainInbox();
  });
  await guarded("purge clicks", async () => {
    await d.purgeClicks(new Date(now.getTime() - 120 * 86_400_000));
  });
  if (!(await d.enabled())) return { ...sum, disabled: true };

  await eachPage((after) => d.openPayouts(d.livemode, ["transferring", "reconcile"], after, PAGE), (p) => p.id, (p) =>
    guarded(`settle ${p.id}`, () => settleInFlight(p, d, sum)));

  await eachPage((after) => d.membersToVisit(d.livemode, after, PAGE), (m) => m, (memberId) =>
    guarded(`creator ${memberId}`, async () => {
      await reverse(memberId, d, sum);
      if (!(await d.payoutAccount(memberId))) {
        sum.waiting++;
        return;
      }
      const c = await d.claim(memberId, d.livemode, now);
      if (c.outcome === "awaiting_approval") sum.awaiting_approval++;
    }));

  await eachPage((after) => d.openPayouts(d.livemode, ["claimed"], after, PAGE), (p) => p.id, (p) =>
    guarded(`send ${p.id}`, () => send(p, d, sum)));

  if (sum.awaiting_approval > 0) await d.alert(`${sum.awaiting_approval} affiliate payout(s) wait for a first-payout approval.`);
  if (sum.errors > 0) await d.alert(`The affiliate payout run had ${sum.errors} error(s); see the logs. Other creators were processed.`);
  return sum;
}

export async function membersToVisit(livemode: boolean, after: string, limit: number): Promise<string[]> {
  const { data, error } = await affiliateRpc("affiliate_members_to_visit", { p_livemode: livemode, p_after: after || null, p_limit: limit });
  if (error) throw new Error(`affiliate members read failed: ${error.message}`);
  return ((data ?? []) as Array<string | { affiliate_members_to_visit: string }>).map((r) => (typeof r === "string" ? r : r.affiliate_members_to_visit));
}

export async function startPayout(payoutId: string, destination: string, now: Date) {
  const { data, error } = await affiliateRpc("affiliate_payout_start", { p_payout_id: payoutId, p_min_cents: MIN_PAYOUT_CENTS, p_destination: destination, p_now: now.toISOString() });
  if (error) throw new Error(`affiliate payout start failed: ${error.message}`);
  return data as { outcome: string; amount_cents?: number };
}

export async function claimPayout(memberId: string, livemode: boolean, now: Date) {
  const { data, error } = await affiliateRpc("affiliate_payout_claim", { p_member_id: memberId, p_min_cents: MIN_PAYOUT_CENTS, p_livemode: livemode, p_now: now.toISOString() });
  if (error) throw new Error(`affiliate payout claim failed: ${error.message}`);
  return data as { outcome: string; payout_id?: string; amount_cents?: number };
}

export async function movePayout(payoutId: string, from: string, to: string, transferId: string | null = null, err: string | null = null, actor: string | null = null) {
  const { data, error } = await affiliateRpc("affiliate_payout_move", {
    p_payout_id: payoutId, p_from: from, p_to: to, p_transfer_id: transferId, p_error: err, p_actor: actor,
  });
  if (error) throw new Error(`affiliate payout move failed: ${error.message}`);
  return String((data as { outcome?: string } | null)?.outcome);
}

export async function openPayouts(livemode: boolean, states: string[], after: string, limit: number): Promise<OpenPayout[]> {
  const { data, error } = await globalClient()
    .from("affiliate_payouts")
    .select("id, member_id, amount_cents, state, updated_at, first_attempt_at, destination_account")
    .eq("livemode", livemode)
    .in("state", states)
    .gt("id", after || "00000000-0000-0000-0000-000000000000")
    .order("id")
    .limit(limit);
  if (error) throw new Error(`affiliate payouts read failed: ${error.message}`);
  return (data ?? []) as OpenPayout[];
}

export async function reversalClaim(memberId: string, livemode: boolean) {
  const { data, error } = await affiliateRpc("affiliate_reversal_claim", { p_member_id: memberId, p_livemode: livemode });
  if (error) throw new Error(`affiliate reversal claim failed: ${error.message}`);
  return data as { outcome: string; reversal_id?: string; transfer_id?: string | null; amount_cents?: number; state?: string; updated_at?: string };
}

export async function reversalStart(id: string) {
  const { data, error } = await affiliateRpc("affiliate_reversal_start", { p_id: id });
  if (error) throw new Error(`affiliate reversal start failed: ${error.message}`);
  return data as { outcome: string; amount_cents?: number };
}

export async function reversalMove(id: string, from: string, to: string, stripeId: string | null = null, err: string | null = null) {
  const { data, error } = await affiliateRpc("affiliate_reversal_move", { p_id: id, p_from: from, p_to: to, p_stripe_id: stripeId, p_error: err });
  if (error) throw new Error(`affiliate reversal move failed: ${error.message}`);
  return String((data as { outcome?: string } | null)?.outcome);
}

export async function purgeClicks(olderThan: Date): Promise<number> {
  let total = 0;
  for (let i = 0; i < 50; i++) {
    const { data, error } = await affiliateRpc("affiliate_purge_clicks", { p_before: olderThan.toISOString(), p_limit: 5000 });
    if (error) throw new Error(`affiliate click purge failed: ${error.message}`);
    const n = Number(data ?? 0);
    total += n;
    if (n < 5000) break;
  }
  return total;
}

export async function creatorApproved(memberId: string): Promise<boolean> {
  const { data, error } = await globalClient().from("human_members").select("vetting_state").eq("id", memberId).maybeSingle<{ vetting_state: string }>();
  if (error) throw new Error(`creator read failed: ${error.message}`);
  return data?.vetting_state === "approved";
}
