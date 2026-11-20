
import { serviceClient } from "@/services/supabase";
import { ExpectedToolError } from "@/services/tools/types";
import { DECISION_CLASS } from "@/services/agents/autopilot-pipeline-contract";

export type MoneyModel = "path_a" | "path_b";

export const MONEY_MODEL_DECISION_CLASS = DECISION_CLASS.STRIPE_CREATE_CONNECTED_ACCOUNT;

type LoadFn = (tenant_id: string) => Promise<string | null>;

const defaultLoad: LoadFn = async (tenant_id) => {
  const { data, error } = await serviceClient()
    .from("tenant_decision_class_overrides")
    .select("money_model")
    .eq("tenant_id", tenant_id)
    .eq("decision_class", MONEY_MODEL_DECISION_CLASS)
    .maybeSingle();
  if (error) throw new Error(`money_model read failed: ${error.message}`);
  return (data as { money_model?: string | null } | null)?.money_model ?? null;
};

export async function resolveMoneyModel(
  tenant_id: string,
  load: LoadFn = defaultLoad,
): Promise<MoneyModel> {
  const raw = await load(tenant_id);
  if (raw === "path_a" || raw === "path_b") return raw;
  throw new ExpectedToolError(
    "money_model_not_chosen",
    "This workspace has not chosen a Stripe money model (path_a = own-Stripe direct charge, or path_b = Praxis collect+remit). Choose one in the autopilot activation/waiver before collecting any payment.",
  );
}
