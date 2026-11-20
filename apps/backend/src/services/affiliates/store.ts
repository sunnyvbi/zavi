import { randomInt } from "node:crypto";
import { affiliateRpc, globalClient, staffCrossTenantClient } from "@/services/tenant-client";

const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
export const CODE_RE = /^[a-km-np-z2-9]{8}$/;

export function newCode(): string {
  let s = "";
  for (let i = 0; i < 8; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return s;
}

export async function codeFor(memberId: string): Promise<string> {
  const { data, error } = await globalClient().from("affiliate_codes").select("code").eq("member_id", memberId).maybeSingle<{ code: string }>();
  if (error) throw new Error(`affiliate code read failed: ${error.message}`);
  if (data) return data.code;
  for (let i = 0; i < 5; i++) {
    const code = newCode();
    const ins = await globalClient().from("affiliate_codes").insert({ member_id: memberId, code });
    if (!ins.error) return code;
    if (ins.error.code !== "23505") throw new Error(`affiliate code insert failed: ${ins.error.message}`);
    const again = await globalClient().from("affiliate_codes").select("code").eq("member_id", memberId).maybeSingle<{ code: string }>();
    if (again.data) return again.data.code;
  }
  throw new Error("affiliate code: could not find a free code");
}

export async function recordClick(code: string): Promise<string | null> {
  if (!CODE_RE.test(code)) return null;
  const { data, error } = await globalClient().from("affiliate_clicks").insert({ code }).select("id").single<{ id: string }>();
  if (error) {
    if (error.code === "23503") return null;
    throw new Error(`affiliate click insert failed: ${error.message}`);
  }
  return data.id;
}

export type AttributeOutcome = "attributed" | "already_attributed" | "unknown_click" | "expired" | "not_eligible" | "self_referral" | "existing_customer";

export async function attribute(tenantId: string, clickId: string, door: "activate" | "build_start" | "checkout", signupEmail: string | null, userId: string | null): Promise<AttributeOutcome> {
  const { data, error } = await affiliateRpc("affiliate_attribute", {
    p_tenant_id: tenantId,
    p_click_id: clickId,
    p_door: door,
    p_signup_email: signupEmail ?? "",
    p_user_id: userId,
  });
  if (error) throw new Error(`affiliate attribute failed: ${error.message}`);
  return String((data as { outcome?: string } | null)?.outcome) as AttributeOutcome;
}

const crossTenant = () => staffCrossTenantClient("affiliate billing: map a Stripe customer or a creator's own login to tenants");

export async function tenantForCustomer(customerId: string): Promise<string | null> {
  const { data, error } = await crossTenant()
    .from("tenant_subscriptions")
    .select("tenant_id")
    .eq("stripe_customer_id", customerId)
    .maybeSingle<{ tenant_id: string }>();
  if (error) throw new Error(`affiliate tenant lookup failed: ${error.message}`);
  return data?.tenant_id ?? null;
}

export type Referral = { member_id: string; anchor_at: string | null; signals?: Record<string, unknown> | null };

export async function referralFor(tenantId: string): Promise<Referral | null> {
  const { data, error } = await globalClient()
    .from("affiliate_referrals")
    .select("member_id, anchor_at, signals")
    .eq("tenant_id", tenantId)
    .maybeSingle<Referral>();
  if (error) throw new Error(`affiliate referral read failed: ${error.message}`);
  return data ?? null;
}

export async function ownCustomersOf(memberId: string, exceptTenantId: string): Promise<string[]> {
  const m = await globalClient().from("human_members").select("auth_user_id").eq("id", memberId).maybeSingle<{ auth_user_id: string | null }>();
  if (m.error) throw new Error(`affiliate member read failed: ${m.error.message}`);
  if (!m.data?.auth_user_id) return [];
  const tu = await crossTenant().from("tenant_users").select("tenant_id").eq("user_id", m.data.auth_user_id);
  if (tu.error) throw new Error(`affiliate member tenants read failed: ${tu.error.message}`);
  const tenants = ((tu.data ?? []) as Array<{ tenant_id: string }>).map((r) => r.tenant_id).filter((t) => t !== exceptTenantId);
  if (tenants.length === 0) return [];
  const subs = await crossTenant().from("tenant_subscriptions").select("stripe_customer_id").in("tenant_id", tenants);
  if (subs.error) throw new Error(`affiliate member customers read failed: ${subs.error.message}`);
  return ((subs.data ?? []) as Array<{ stripe_customer_id: string | null }>).map((r) => r.stripe_customer_id).filter((c): c is string => !!c);
}

export async function markSelfReferral(tenantId: string, signals: Record<string, unknown> | null | undefined): Promise<void> {
  const { error } = await globalClient()
    .from("affiliate_referrals")
    .update({ signals: { ...(signals ?? {}), self_referral: "own_card" } })
    .eq("tenant_id", tenantId);
  if (error) throw new Error(`affiliate self-referral write failed: ${error.message}`);
}

export async function accrue(args: {
  tenantId: string;
  chargeId: string;
  chargeAmountCents: number;
  livemode: boolean;
  cardFingerprint: string | null;
  anchor: string;
  entries: unknown[];
}): Promise<{ outcome: string; anchor_at?: string }> {
  const { data, error } = await affiliateRpc("affiliate_accrue", {
    p_tenant_id: args.tenantId,
    p_charge_id: args.chargeId,
    p_charge_amount_cents: args.chargeAmountCents,
    p_livemode: args.livemode,
    p_card_fingerprint: args.cardFingerprint,
    p_anchor: args.anchor,
    p_entries: args.entries,
  });
  if (error) throw new Error(`affiliate accrue failed: ${error.message}`);
  return data as { outcome: string; anchor_at?: string };
}

const outcomeOf = (data: unknown) => String((data as { outcome?: string } | null)?.outcome);

export async function parkEvent(eventId: string): Promise<void> {
  const { error } = await globalClient().from("affiliate_event_inbox").upsert({ event_id: eventId }, { onConflict: "event_id", ignoreDuplicates: true });
  if (error) throw new Error(`affiliate inbox write failed: ${error.message}`);
}

export async function parkedEvents(limit: number): Promise<string[]> {
  const { data, error } = await globalClient().from("affiliate_event_inbox").select("event_id").eq("dead", false).order("created_at").limit(limit);
  if (error) throw new Error(`affiliate inbox read failed: ${error.message}`);
  return ((data ?? []) as Array<{ event_id: string }>).map((r) => r.event_id);
}

export async function failParkedEvent(eventId: string, err: string): Promise<{ dead: boolean }> {
  const { data, error } = await affiliateRpc("affiliate_inbox_fail", { p_event_id: eventId, p_error: err });
  if (error) throw new Error(`affiliate inbox update failed: ${error.message}`);
  return { dead: data === true };
}

export async function replayParkedEvent(eventId: string): Promise<boolean> {
  const { data, error } = await globalClient().from("affiliate_event_inbox").update({ dead: false, attempts: 0 }).eq("event_id", eventId).select("event_id");
  if (error) throw new Error(`affiliate inbox update failed: ${error.message}`);
  return (data ?? []).length === 1;
}

export async function unparkEvent(eventId: string): Promise<void> {
  const { error } = await globalClient().from("affiliate_event_inbox").delete().eq("event_id", eventId);
  if (error) throw new Error(`affiliate inbox delete failed: ${error.message}`);
}

export async function refund(chargeId: string, refundedCents: number): Promise<string> {
  const { data, error } = await affiliateRpc("affiliate_refund", { p_charge_id: chargeId, p_refunded_cents: refundedCents });
  if (error) throw new Error(`affiliate refund failed: ${error.message}`);
  return outcomeOf(data);
}

export async function creditNote(id: string, chargeId: string, amountCents: number, voided: boolean): Promise<string> {
  const { data, error } = await affiliateRpc("affiliate_credit_note", { p_id: id, p_charge_id: chargeId, p_amount_cents: amountCents, p_voided: voided });
  if (error) throw new Error(`affiliate credit note failed: ${error.message}`);
  return outcomeOf(data);
}

export async function dispute(id: string, chargeId: string, amountCents: number, status: string): Promise<string> {
  const { data, error } = await affiliateRpc("affiliate_dispute", { p_id: id, p_charge_id: chargeId, p_amount_cents: amountCents, p_status: status });
  if (error) throw new Error(`affiliate dispute failed: ${error.message}`);
  return outcomeOf(data);
}
