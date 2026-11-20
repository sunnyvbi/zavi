
import { serviceClient } from "@/services/supabase";
import { resolveConnectedAccountId } from "./_platform-client";
import { retrieveAccountStatus, type AccountStatus } from "./account-status";

export type MoneyModel = "path_a" | "path_b";

export type PayoutAccountState = {
  rail_enabled: boolean;
  money_model: MoneyModel | null;
  account: ({ id: string } & AccountStatus) | null;
  state: "rail_disabled" | "no_account" | "pending" | "active";
};

export type ResolvePayoutAccountDeps = {
  railEnabled: () => boolean;
  loadMoneyModel: (tenant_id: string) => Promise<MoneyModel | null>;
  loadConnectedAccountId: (tenant_id: string) => Promise<string | null>;
  retrieveStatus: (acctId: string) => Promise<AccountStatus | null>;
};

const MONEY_MODEL_DECISION_CLASS = "stripe.create_connected_account";

const defaultLoadMoneyModel = async (tenant_id: string): Promise<MoneyModel | null> => {
  const { data, error } = await serviceClient()
    .from("tenant_decision_class_overrides")
    .select("money_model")
    .eq("tenant_id", tenant_id)
    .eq("decision_class", MONEY_MODEL_DECISION_CLASS)
    .maybeSingle();
  if (error) throw new Error(`money_model read failed: ${error.message}`);
  const raw = (data as { money_model?: string | null } | null)?.money_model ?? null;
  return raw === "path_a" || raw === "path_b" ? raw : null;
};

export const realResolvePayoutAccountDeps: ResolvePayoutAccountDeps = {
  railEnabled: () =>
    !!process.env.STRIPE_PLATFORM_SECRET_KEY &&
    process.env.STRIPE_PROVISIONING_ENABLED === "1",
  loadMoneyModel: defaultLoadMoneyModel,
  loadConnectedAccountId: (tenant_id) => resolveConnectedAccountId(tenant_id),
  retrieveStatus: (acctId) => retrieveAccountStatus(acctId),
};

export async function resolvePayoutAccountState(
  tenant_id: string,
  deps: ResolvePayoutAccountDeps = realResolvePayoutAccountDeps,
): Promise<PayoutAccountState> {
  const rail_enabled = deps.railEnabled();
  const money_model = await deps.loadMoneyModel(tenant_id);
  const acctId = await deps.loadConnectedAccountId(tenant_id);

  if (!rail_enabled) {
    return {
      rail_enabled: false,
      money_model,
      account: acctId ? { id: acctId, charges_enabled: false, payouts_enabled: false, details_submitted: false } : null,
      state: "rail_disabled",
    };
  }

  if (!acctId) {
    return { rail_enabled: true, money_model, account: null, state: "no_account" };
  }

  const status = await deps.retrieveStatus(acctId);
  const flags: AccountStatus = status ?? {
    charges_enabled: false,
    payouts_enabled: false,
    details_submitted: false,
  };
  const active = flags.charges_enabled && flags.payouts_enabled;
  return {
    rail_enabled: true,
    money_model,
    account: { id: acctId, ...flags },
    state: active ? "active" : "pending",
  };
}
