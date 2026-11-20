import { asTenantId, tenantClient } from "@/services/tenant-client";

export type FundingContext =
  | { status: "unavailable"; reason: string }
  | {
      status: "read";
      currency: "USD";
      balance_cents: number;
      reserved_cents: number;
      available_cents: number;
      auto_refill_enabled: boolean;
      read_at: string;
      activation: "requires_campaign_review_and_reservation";
    };

const cents = (value: unknown): number => {
  if (typeof value !== "number" && !(typeof value === "string" && /^-?\d+$/.test(value))) throw new Error("Invalid wallet amount");
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error("Invalid wallet amount");
  return n;
};

export async function readReservations(tenantId: string): Promise<number> {
  const db = tenantClient(asTenantId(tenantId));
  let reserved = 0;
  for (let offset = 0; ; offset += 500) {
    const page = await db.from("ads_campaign_reservations").select("campaign_binding_id, reserved_cents")
      .eq("tenant_id", tenantId).order("campaign_binding_id").range(offset, offset + 499);
    if (page.error || !Array.isArray(page.data)) throw new Error("Reservations unavailable");
    for (const row of page.data as Array<{ reserved_cents: unknown }>) {
      const amount = cents(row.reserved_cents);
      if (amount < 0) throw new Error("Invalid reservation");
      reserved += amount;
      if (!Number.isSafeInteger(reserved)) throw new Error("Invalid reservation total");
    }
    if (page.data.length < 500) break;
    if (offset >= 49_500) throw new Error("Incomplete reservation read");
  }
  return reserved;
}

export async function readFundingContext(tenantId: string): Promise<FundingContext> {
  try {
    const db = tenantClient(asTenantId(tenantId));
    const res = await db.from("ads_wallets").select("balance_cents, auto_refill_enabled").eq("tenant_id", tenantId).maybeSingle();
    if (res.error) throw new Error("Wallet unavailable");
    const wallet = { data: res.data as { balance_cents: unknown; auto_refill_enabled: unknown } | null };
    const reserved = await readReservations(tenantId);
    if (!wallet.data && reserved !== 0) throw new Error("Wallet missing for existing coverage");
    const balance = wallet.data ? cents(wallet.data.balance_cents) : 0;
    const available = balance - reserved;
    if (!Number.isSafeInteger(available)) throw new Error("Invalid available balance");
    return {
      status: "read", currency: "USD", balance_cents: balance, reserved_cents: reserved,
      available_cents: available, auto_refill_enabled: wallet.data?.auto_refill_enabled === true,
      read_at: new Date().toISOString(), activation: "requires_campaign_review_and_reservation",
    };
  } catch {
    return { status: "unavailable", reason: "Ads wallet could not be verified; balance and campaign funding are unknown." };
  }
}
