import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";

export const RETIRED_REASON = "lazy_provisioning_retired: finish setup at /start";

export const autoProvisionTenantFn = inngest.createFunction(
  { id: "auto-provision-tenant" },
  { event: "tenant.auto_provision.requested" },
  async ({ event, step, logger }) => {
    const user_id = event.data.user_id;
    if (!user_id || typeof user_id !== "string") {
      return { status: "skip", reason: "missing_user_id" };
    }
    const result = await step.run("settle-provisioning-row", async () =>
      settleProvisioningRow(user_id),
    );
    logger.info(`auto-provision-tenant (retired): user ${user_id} -> ${result.status}`);
    return result;
  },
);

export async function settleProvisioningRow(
  user_id: string,
  sb = serviceClient(),
): Promise<{ status: "ready" | "failed" | "absent"; tenant_id: string | null }> {
  const { data: row, error: rowErr } = await sb
    .from("tenant_provisioning")
    .select("status, tenant_id")
    .eq("user_id", user_id)
    .maybeSingle();
  if (rowErr) throw new Error(`tenant_provisioning read failed: ${rowErr.message}`);
  if (!row) return { status: "absent", tenant_id: null };
  if (row.status === "ready" && row.tenant_id) return { status: "ready", tenant_id: row.tenant_id };

  const { data: member, error: memErr } = await sb
    .from("tenant_users")
    .select("tenant_id")
    .eq("user_id", user_id)
    .limit(1)
    .maybeSingle();
  if (memErr) throw new Error(`tenant_users read failed: ${memErr.message}`);

  const now = new Date().toISOString();
  const patch = member?.tenant_id
    ? { status: "ready", tenant_id: member.tenant_id, failure_reason: null, updated_at: now }
    : { status: "failed", failure_reason: RETIRED_REASON, updated_at: now };
  const { error: updErr } = await sb
    .from("tenant_provisioning")
    .update(patch)
    .eq("user_id", user_id)
    .neq("status", "ready");
  if (updErr) throw new Error(`tenant_provisioning settle failed: ${updErr.message}`);
  return member?.tenant_id
    ? { status: "ready", tenant_id: member.tenant_id }
    : { status: "failed", tenant_id: null };
}
