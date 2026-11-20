
import { serviceClient } from "@/services/supabase";

export type StaffAuditInput = {
  actor_user_id: string;
  actor_email: string;
  action: string;
  target_table?: string | null;
  target_id?: string | null;
  tenant_id?: string | null;
  meta?: Record<string, unknown>;
};

export async function writeStaffAudit(input: StaffAuditInput): Promise<void> {
  const { error } = await serviceClient()
    .from("staff_audit_log")
    .insert({
      actor_user_id: input.actor_user_id,
      actor_email: input.actor_email,
      action: input.action,
      target_table: input.target_table ?? null,
      target_id: input.target_id ?? null,
      tenant_id: input.tenant_id ?? null,
      meta: input.meta ?? {},
    });
  if (error) {
    console.warn(`[staff-audit] insert failed for action=${input.action}: ${error.message}`);
  }
}

export async function writeStaffAuditStrict(input: StaffAuditInput): Promise<void> {
  const { error } = await serviceClient()
    .from("staff_audit_log")
    .insert({
      actor_user_id: input.actor_user_id,
      actor_email: input.actor_email,
      action: input.action,
      target_table: input.target_table ?? null,
      target_id: input.target_id ?? null,
      tenant_id: input.tenant_id ?? null,
      meta: input.meta ?? {},
    });
  if (error) throw new Error(`staff audit write failed for ${input.action}: ${error.message}`);
}
