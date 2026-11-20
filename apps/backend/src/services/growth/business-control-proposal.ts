import { z } from "zod";
import { businessPolicySchema } from "./business-control-policy";
import { asTenantId, tenantRpc } from "@/services/tenant-client";

export const BUSINESS_CONTROLS_CLASS = "growth.save_business_controls";
export const businessControlsApprovalSchema = z
  .object({
    policy: businessPolicySchema,
    expected_policy: businessPolicySchema,
    revision: z.number().int().nonnegative(),
  })
  .strict();

export async function approveBusinessControls(
  tenantId: string,
  actor: string,
  decisionId: string,
  input: unknown,
) {
  const parsed = businessControlsApprovalSchema.safeParse(input);
  if (!parsed.success) return { status: "invalid_edit" as const };
  const { data, error } = await tenantRpc(
    asTenantId(tenantId),
    "approve_growth_business_controls",
    {
      p_actor: actor,
      p_decision_id: decisionId,
      p_policy: parsed.data.policy,
      p_expected_policy: parsed.data.expected_policy,
      p_revision: parsed.data.revision,
    },
  );
  if (error?.message === "Pro plan required")
    return { status: "plan_required" as const };
  if (error) throw new Error(error.message);
  return data as { status: string; changed?: boolean };
}
