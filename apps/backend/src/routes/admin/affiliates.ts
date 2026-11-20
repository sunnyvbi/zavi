import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { globalClient } from "@/services/tenant-client";
import { movePayout } from "@/services/affiliates/payouts";
import { creatorStripeClient } from "@/services/creators/client";
import { reversalMove } from "@/services/affiliates/payouts";
import { replayParkedEvent } from "@/services/affiliates/store";
import { affiliateRpc } from "@/services/tenant-client";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function staffAffiliatePayouts(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const { data, error } = await globalClient()
    .from("affiliate_payouts")
    .select("id, member_id, amount_cents, state, error, stripe_transfer_id, created_at, updated_at")
    .in("state", ["awaiting_approval", "claimed", "transferring", "reconcile"])
    .order("created_at")
    .limit(500);
  if (error) {
    res.status(500).json({ error: { code: "internal", message: error.message } });
    return;
  }
  const rows = (data ?? []) as Array<{ member_id: string }>;
  const ids = [...new Set(rows.map((r) => r.member_id))];
  const names = new Map<string, string>();
  const signals = new Map<string, Array<{ tenant_id: string; door: string; signals: unknown }>>();
  if (ids.length) {
    const [m, refs] = await Promise.all([
      globalClient().from("human_members").select("id, display_name").in("id", ids),
      globalClient().from("affiliate_referrals").select("member_id, tenant_id, door, signals").in("member_id", ids).limit(5000),
    ]);
    for (const r of (m.data ?? []) as Array<{ id: string; display_name: string }>) names.set(r.id, r.display_name);
    for (const r of (refs.data ?? []) as Array<{ member_id: string; tenant_id: string; door: string; signals: unknown }>) {
      const list = signals.get(r.member_id) ?? [];
      list.push({ tenant_id: r.tenant_id, door: r.door, signals: r.signals });
      signals.set(r.member_id, list);
    }
  }
  res.json({
    payouts: rows.map((r) => ({ ...r, creator: names.get(r.member_id) ?? null, referrals: signals.get(r.member_id) ?? [] })),
  });
}

async function moveAs(req: Request, res: Response, from: string[], to: string, transferId: string | null = null): Promise<void> {
  const staff = assertStaff(req);
  const id = String(req.params.id ?? "");
  if (!UUID_RE.test(id)) {
    res.status(400).json({ error: { code: "bad_id", message: "payout id must be a uuid" } });
    return;
  }
  try {
    const cur = await globalClient().from("affiliate_payouts").select("state").eq("id", id).maybeSingle<{ state: string }>();
    const state = cur.data?.state;
    if (!state || !from.includes(state)) {
      res.status(409).json({ error: { code: "wrong_state", message: `This payout is ${state ?? "missing"}.` } });
      return;
    }
    const note = to === "rejected" ? `rejected by ${staff.email}` : to === "failed" ? `released by ${staff.email}` : null;
    const out = await movePayout(id, state, to, transferId, note, staff.user_id);
    if (out !== "moved") {
      res.status(409).json({ error: { code: out, message: "The payout changed; reload and try again." } });
      return;
    }
    res.json({ ok: true, state: to });
  } catch (e) {
    res.status(500).json({ error: { code: "internal", message: (e as Error).message } });
  }
}

export const staffAffiliatePayoutApprove = (req: Request, res: Response) => moveAs(req, res, ["awaiting_approval"], "claimed");
export const staffAffiliatePayoutReject = (req: Request, res: Response) => moveAs(req, res, ["awaiting_approval"], "rejected");

const DAY_MS = 24 * 3600_000;

async function loadPayout(id: string) {
  const { data } = await globalClient()
    .from("affiliate_payouts")
    .select("id, member_id, livemode, amount_cents, updated_at, first_attempt_at, destination_account, state")
    .eq("id", id)
    .maybeSingle<{ id: string; member_id: string; livemode: boolean; amount_cents: number; updated_at: string; first_attempt_at: string | null; destination_account: string | null; state: string }>();
  return data ?? null;
}

export async function staffAffiliatePayoutRecord(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const id = String(req.params.id ?? "");
  const t = String((req.body as { transfer_id?: unknown } | undefined)?.transfer_id ?? "");
  if (!UUID_RE.test(id) || !/^tr_[A-Za-z0-9]+$/.test(t)) {
    res.status(400).json({ error: { code: "bad_input", message: "payout id must be a uuid and transfer_id a Stripe transfer id (tr_...)" } });
    return;
  }
  const p = await loadPayout(id);
  try {
    const tr = await creatorStripeClient().transfers.retrieve(t);
    const dest = typeof tr.destination === "string" ? tr.destination : tr.destination?.id;
    if (
      !p || !p.destination_account || tr.transfer_group !== `affiliate_${id}` || tr.amount !== p.amount_cents ||
      tr.currency !== "usd" || tr.livemode !== p.livemode || dest !== p.destination_account
    ) {
      res.status(409).json({ error: { code: "transfer_mismatch", message: "That transfer is not this payout's (group, amount, currency, mode or destination differ)." } });
      return;
    }
  } catch (e) {
    res.status(502).json({ error: { code: "stripe_error", message: (e as Error).message } });
    return;
  }
  return moveAs(req, res, ["reconcile"], "sent", t);
}

export async function staffAffiliatePayoutRelease(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const id = String(req.params.id ?? "");
  if (!UUID_RE.test(id)) {
    res.status(400).json({ error: { code: "bad_id", message: "payout id must be a uuid" } });
    return;
  }
  const p = await loadPayout(id);
  if (!p || Date.now() - new Date(p.first_attempt_at ?? p.updated_at).getTime() < DAY_MS) {
    res.status(409).json({ error: { code: "too_early", message: "Wait until 24 hours after the last attempt before releasing it." } });
    return;
  }
  try {
    const found = await creatorStripeClient().transfers.list({ transfer_group: `affiliate_${id}`, limit: 1 });
    if (found.data[0]) {
      res.status(409).json({ error: { code: "transfer_exists", message: `Stripe has ${found.data[0].id} for this payout: record it instead.` } });
      return;
    }
  } catch (e) {
    res.status(502).json({ error: { code: "stripe_error", message: (e as Error).message } });
    return;
  }
  return moveAs(req, res, ["reconcile"], "failed");
}

async function loadReversal(id: string) {
  const { data } = await globalClient()
    .from("affiliate_reversals")
    .select("id, payout_id, amount_cents, state, attempted_at")
    .eq("id", id)
    .maybeSingle<{ id: string; payout_id: string; amount_cents: number; state: string; attempted_at: string | null }>();
  if (!data) return null;
  const p = await globalClient().from("affiliate_payouts").select("stripe_transfer_id").eq("id", data.payout_id).maybeSingle<{ stripe_transfer_id: string | null }>();
  return { ...data, transfer_id: p.data?.stripe_transfer_id ?? null };
}

export async function staffAffiliateReversalRecord(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const id = String(req.params.id ?? "");
  const rid = String((req.body as { reversal_id?: unknown } | undefined)?.reversal_id ?? "");
  if (!UUID_RE.test(id) || !/^trr_[A-Za-z0-9]+$/.test(rid)) {
    res.status(400).json({ error: { code: "bad_input", message: "id must be a uuid and reversal_id a Stripe reversal id (trr_...)" } });
    return;
  }
  const r = await loadReversal(id);
  if (!r || r.state !== "reconcile" || !r.transfer_id) {
    res.status(409).json({ error: { code: "wrong_state", message: "This reversal is not waiting for a person." } });
    return;
  }
  try {
    const x = await creatorStripeClient().transfers.retrieveReversal(r.transfer_id, rid);
    const ours = x.metadata?.affiliate_reversal_id === id;
    const byHand = !x.metadata?.affiliate_reversal_id && r.attempted_at && x.created * 1000 >= new Date(r.attempted_at).getTime() - 5 * 60_000;
    const taken = await globalClient().from("affiliate_reversals").select("id").eq("stripe_reversal_id", rid).maybeSingle();
    if (x.amount !== r.amount_cents || !(ours || byHand) || taken.data) {
      res.status(409).json({ error: { code: "reversal_mismatch", message: "That reversal is not this one (amount, id or time differ, or it is already recorded)." } });
      return;
    }
    res.json({ ok: (await reversalMove(id, "reconcile", "sent", rid)) === "moved" });
  } catch (e) {
    res.status(502).json({ error: { code: "stripe_error", message: (e as Error).message } });
  }
}

export async function staffAffiliateReversalRelease(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const id = String(req.params.id ?? "");
  if (!UUID_RE.test(id)) {
    res.status(400).json({ error: { code: "bad_id", message: "id must be a uuid" } });
    return;
  }
  const r = await loadReversal(id);
  if (!r || r.state !== "reconcile" || !r.transfer_id || Date.now() - new Date(r.attempted_at ?? 0).getTime() < DAY_MS) {
    res.status(409).json({ error: { code: "too_early", message: "Only an unsettled reversal, 24 hours after its attempt." } });
    return;
  }
  try {
    const known = await globalClient().from("affiliate_reversals").select("stripe_reversal_id").eq("payout_id", r.payout_id).not("stripe_reversal_id", "is", null);
    const recorded = new Set(((known.data ?? []) as Array<{ stripe_reversal_id: string }>).map((k) => k.stripe_reversal_id));
    for await (const x of creatorStripeClient().transfers.listReversals(r.transfer_id, { limit: 100 })) {
      if (!recorded.has(x.id)) {
        res.status(409).json({ error: { code: "reversal_exists", message: `Stripe has ${x.id} on this transfer that is not recorded: record it instead.` } });
        return;
      }
    }
    res.json({ ok: (await reversalMove(id, "reconcile", "failed", null, "released by staff: never happened")) === "moved" });
  } catch (e) {
    res.status(502).json({ error: { code: "stripe_error", message: (e as Error).message } });
  }
}

export async function staffAffiliateInboxReplay(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const id = String(req.params.event_id ?? "");
  if (!/^evt_[A-Za-z0-9]+$/.test(id)) {
    res.status(400).json({ error: { code: "bad_id", message: "event_id must be a Stripe event id (evt_...)" } });
    return;
  }
  try {
    res.json({ ok: await replayParkedEvent(id) });
  } catch (e) {
    res.status(500).json({ error: { code: "internal", message: (e as Error).message } });
  }
}

export async function staffAffiliateExternalReversal(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const id = String(req.params.id ?? "");
  const rid = String((req.body as { reversal_id?: unknown } | undefined)?.reversal_id ?? "");
  if (!UUID_RE.test(id) || !/^trr_[A-Za-z0-9]+$/.test(rid)) {
    res.status(400).json({ error: { code: "bad_input", message: "id must be a uuid and reversal_id a Stripe reversal id (trr_...)" } });
    return;
  }
  const p = await globalClient().from("affiliate_payouts").select("stripe_transfer_id, state").eq("id", id).maybeSingle<{ stripe_transfer_id: string | null; state: string }>();
  if (!p.data?.stripe_transfer_id || p.data.state !== "sent") {
    res.status(409).json({ error: { code: "not_sent", message: "Only a sent payout has a transfer to reverse." } });
    return;
  }
  try {
    const x = await creatorStripeClient().transfers.retrieveReversal(p.data.stripe_transfer_id, rid);
    if (x.metadata?.affiliate_reversal_id) {
      res.status(409).json({ error: { code: "ours", message: "That reversal is one of ours: use the reversal's own record action." } });
      return;
    }
    const open = await globalClient().from("affiliate_reversals").select("id").eq("payout_id", id).in("state", ["claimed", "reconcile"]);
    const openIds = new Set(((open.data ?? []) as Array<{ id: string }>).map((o) => o.id));
    if (openIds.size) {
      for await (const y of creatorStripeClient().transfers.listReversals(p.data.stripe_transfer_id, { limit: 100 })) {
        const ourId = y.metadata?.affiliate_reversal_id;
        if (ourId && openIds.has(ourId)) {
          res.status(409).json({ error: { code: "ours_exists", message: `Stripe already has our reversal ${y.id} for this payout: record that one first.` } });
          return;
        }
      }
    }
    const { data, error } = await affiliateRpc("affiliate_reversal_external", { p_payout_id: id, p_stripe_reversal_id: rid, p_amount_cents: x.amount });
    if (error) throw new Error(error.message);
    res.json({ ok: (data as { outcome?: string } | null)?.outcome === "recorded", outcome: (data as { outcome?: string } | null)?.outcome });
  } catch (e) {
    res.status(502).json({ error: { code: "stripe_error", message: (e as Error).message } });
  }
}
