import { affiliateRpc, globalClient } from "@/services/tenant-client";
import { codeFor } from "./store";

export type AffiliateEntryView = {
  created_at: string;
  kind: "commission" | "adjustment" | "recovered";
  amount_cents: number;
  month_index: number | null;
  rate: number | null;
  matures_at: string;
  paid: boolean;
};

export type AffiliateSummary = {
  code: string;
  clicks_30d: number;
  signups: number;
  paying: number;
  pending_cents: number;
  payable_cents: number;
  paid_cents: number;
  open_payout: { state: string; amount_cents: number } | null;
  entries: AffiliateEntryView[];
};

export async function affiliateSummary(memberId: string, livemode: boolean, now = new Date()): Promise<AffiliateSummary> {
  const code = await codeFor(memberId);
  const since = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const db = globalClient();
  const [clicks, totals, entries, open] = await Promise.all([
    db.from("affiliate_clicks").select("id", { count: "exact", head: true }).eq("code", code).gte("clicked_at", since),
    affiliateRpc("affiliate_member_totals", { p_member_id: memberId, p_livemode: livemode, p_now: now.toISOString() }),
    db.from("affiliate_entries")
      .select("created_at, kind, amount_cents, month_index, rate, matures_at, payout_id")
      .eq("member_id", memberId)
      .eq("livemode", livemode)
      .order("created_at", { ascending: false })
      .limit(200),
    db.from("affiliate_payouts")
      .select("state, amount_cents")
      .eq("member_id", memberId)
      .eq("livemode", livemode)
      .in("state", ["awaiting_approval", "claimed", "transferring", "reconcile"])
      .order("created_at", { ascending: false })
      .limit(1),
  ]);
  for (const r of [clicks, totals, entries, open]) if (r.error) throw new Error(`affiliate summary read failed: ${r.error.message}`);
  const t = (totals.data ?? {}) as { pending_cents?: number; payable_cents?: number; paid_cents?: number; paying?: number; signups?: number };
  const rows = (entries.data ?? []) as Array<{
    created_at: string; kind: AffiliateEntryView["kind"]; amount_cents: number; month_index: number | null;
    rate: number | string | null; matures_at: string; payout_id: string | null;
  }>;
  const payoutIds = [...new Set(rows.map((r) => r.payout_id).filter((x): x is string => Boolean(x)))];
  const states = new Map<string, string>();
  if (payoutIds.length) {
    const p = await db.from("affiliate_payouts").select("id, state").in("id", payoutIds);
    if (p.error) throw new Error(`affiliate summary read failed: ${p.error.message}`);
    for (const r of (p.data ?? []) as Array<{ id: string; state: string }>) states.set(r.id, r.state);
  }
  const o = ((open.data ?? []) as Array<{ state: string; amount_cents: number }>)[0];
  return {
    code,
    clicks_30d: clicks.count ?? 0,
    signups: Number(t.signups ?? 0),
    paying: Number(t.paying ?? 0),
    pending_cents: Number(t.pending_cents ?? 0),
    payable_cents: Number(t.payable_cents ?? 0),
    paid_cents: Number(t.paid_cents ?? 0),
    open_payout: o ? { state: o.state, amount_cents: o.amount_cents } : null,
    entries: rows
      .filter((r) => !(r.payout_id && states.get(r.payout_id) === "rejected"))
      .map((r) => ({
        created_at: r.created_at,
        kind: r.kind,
        amount_cents: r.amount_cents,
        month_index: r.month_index,
        rate: r.rate === null ? null : Number(r.rate),
        matures_at: r.matures_at,
        paid: Boolean(r.payout_id && states.get(r.payout_id) === "sent"),
      })),
  };
}
