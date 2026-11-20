
import { serviceClient } from "@/services/supabase";

export type HeldFundStatus = "pending" | "held" | "remitting" | "remitted" | "refunded";

export type HeldFundRow = {
  id: string;
  tenant_id: string;
  charge_id: string | null;
  amount_minor: number;
  currency: string;
  client_reference: string;
  status: HeldFundStatus;
  reserve_held_minor: number;
  platform_fee_minor: number;
  remitted_transfer_id: string | null;
  created_at: string;
  updated_at: string;
};

export type ReserveHeldFundInput = {
  tenant_id: string;
  amount_minor: number;
  currency?: string;
  client_reference: string;
  reserve_held_minor?: number;
  platform_fee_minor?: number;
};

export async function reserveHeldFund(input: ReserveHeldFundInput): Promise<HeldFundRow> {
  if (!input.tenant_id) throw new Error("reserveHeldFund: missing tenant_id");
  if (!input.client_reference) throw new Error("reserveHeldFund: missing client_reference");
  if (!Number.isInteger(input.amount_minor) || input.amount_minor <= 0) {
    throw new Error("reserveHeldFund: amount_minor must be a positive integer");
  }

  const sb = serviceClient();
  const { error: upsertErr } = await sb.from("autopilot_held_funds").upsert(
    {
      tenant_id: input.tenant_id,
      amount_minor: input.amount_minor,
      currency: input.currency ?? "usd",
      client_reference: input.client_reference,
      reserve_held_minor: input.reserve_held_minor ?? 0,
      platform_fee_minor: input.platform_fee_minor ?? 0,
      status: "pending",
    },
    { onConflict: "tenant_id,client_reference", ignoreDuplicates: true },
  );
  if (upsertErr) throw new Error(`reserveHeldFund failed: ${upsertErr.message}`);

  const existing = await findHeldFundByRef(input.tenant_id, input.client_reference);
  if (!existing) throw new Error("reserveHeldFund: row vanished after upsert");
  return existing;
}

export async function markHeldFundCharged(args: {
  id: string;
  charge_id: string;
}): Promise<void> {
  if (!args.id) throw new Error("markHeldFundCharged: missing id");
  if (!args.charge_id) throw new Error("markHeldFundCharged: missing charge_id");
  const sb = serviceClient();
  const { error } = await sb
    .from("autopilot_held_funds")
    .update({
      status: "held",
      charge_id: args.charge_id,
      updated_at: new Date().toISOString(),
    })
    .eq("id", args.id)
    .eq("status", "pending");
  if (error) throw new Error(`markHeldFundCharged failed: ${error.message}`);
}

export async function findHeldFundByRef(
  tenant_id: string,
  client_reference: string,
): Promise<HeldFundRow | null> {
  if (!tenant_id) throw new Error("findHeldFundByRef: missing tenant_id");
  if (!client_reference) throw new Error("findHeldFundByRef: missing client_reference");
  const sb = serviceClient();
  const { data, error } = await sb
    .from("autopilot_held_funds")
    .select("*")
    .eq("tenant_id", tenant_id)
    .eq("client_reference", client_reference)
    .maybeSingle<HeldFundRow>();
  if (error) throw new Error(`findHeldFundByRef failed: ${error.message}`);
  return data ?? null;
}

export async function listHeldFundsForTenant(tenant_id: string): Promise<HeldFundRow[]> {
  if (!tenant_id) throw new Error("listHeldFundsForTenant: missing tenant_id");
  const sb = serviceClient();
  const { data, error } = await sb
    .from("autopilot_held_funds")
    .select("*")
    .eq("tenant_id", tenant_id)
    .eq("status", "held")
    .order("created_at", { ascending: true })
    .returns<HeldFundRow[]>();
  if (error) throw new Error(`listHeldFundsForTenant failed: ${error.message}`);
  return data ?? [];
}

export async function findHeldFundByChargeId(charge_id: string): Promise<HeldFundRow | null> {
  if (!charge_id) return null;
  const sb = serviceClient();
  const { data, error } = await sb
    .from("autopilot_held_funds")
    .select("*")
    .eq("charge_id", charge_id)
    .maybeSingle<HeldFundRow>();
  if (error) throw new Error(`findHeldFundByChargeId failed: ${error.message}`);
  return data ?? null;
}

export async function claimHeldFundForRemit(args: { id: string }): Promise<HeldFundRow | null> {
  if (!args.id) throw new Error("claimHeldFundForRemit: missing id");
  const sb = serviceClient();
  const { data, error } = await sb
    .rpc("autopilot_claim_held_fund_for_remit", { p_id: args.id })
    .maybeSingle<HeldFundRow>();
  if (error) throw new Error(`claimHeldFundForRemit failed: ${error.message}`);
  if (!data || !data.id) return null;
  return data;
}

export async function markHeldFundRemitted(args: {
  id: string;
  transfer_id: string;
}): Promise<boolean> {
  if (!args.id) throw new Error("markHeldFundRemitted: missing id");
  if (!args.transfer_id) throw new Error("markHeldFundRemitted: missing transfer_id");
  const sb = serviceClient();
  const { data, error } = await sb.rpc("autopilot_mark_held_fund_remitted", {
    p_id: args.id,
    p_transfer_id: args.transfer_id,
  });
  if (error) throw new Error(`markHeldFundRemitted failed: ${error.message}`);
  return Number(data) === 1;
}

export async function releaseHeldFundClaim(args: { id: string }): Promise<boolean> {
  if (!args.id) throw new Error("releaseHeldFundClaim: missing id");
  const sb = serviceClient();
  const { data, error } = await sb.rpc("autopilot_release_held_fund_claim", {
    p_id: args.id,
  });
  if (error) throw new Error(`releaseHeldFundClaim failed: ${error.message}`);
  return Number(data) === 1;
}

export async function markHeldFundRefunded(args: { id: string }): Promise<boolean> {
  if (!args.id) throw new Error("markHeldFundRefunded: missing id");
  const sb = serviceClient();
  const { data, error } = await sb.rpc("autopilot_mark_held_fund_refunded", {
    p_id: args.id,
  });
  if (error) throw new Error(`markHeldFundRefunded failed: ${error.message}`);
  return Number(data) === 1;
}
