
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import {
  SIGNUP_FOLLOWUP_DELAY,
  SIGNUP_FOLLOWUP_EVENT,
  sendSignupFollowup,
  type SignupTenant,
} from "@/services/tenants/signup-followup";

export type SignupTarget = { tenant: SignupTenant; user_id: string | null };

export async function resolveSignupTarget(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  tenant_id: string,
  user_id: string | null,
): Promise<SignupTarget | null> {
  const { data: tenant, error } = await sb
    .from("tenants")
    .select("id, slug, display_name, created_at, kind, deleted_at")
    .eq("id", tenant_id)
    .maybeSingle();
  if (error) throw new Error(`signup-followup: tenant read failed: ${error.message}`);
  if (!tenant) return null;
  if (!user_id) return { tenant: tenant as SignupTenant, user_id: null };
  const { data: member, error: memberErr } = await sb
    .from("tenant_users")
    .select("user_id")
    .eq("tenant_id", tenant.id)
    .eq("user_id", user_id)
    .maybeSingle();
  if (memberErr) throw new Error(`signup-followup: membership read failed: ${memberErr.message}`);
  return { tenant: tenant as SignupTenant, user_id: member ? user_id : null };
}

export const signupFollowupWaitFn = inngest.createFunction(
  { id: "signup-followup-wait", concurrency: 20 },
  { event: SIGNUP_FOLLOWUP_EVENT },
  async ({ event, step }) => {
    const { tenant_id, user_id } = event.data as { tenant_id: string; user_id?: string };
    await step.sleep("a-day-after-signup", SIGNUP_FOLLOWUP_DELAY);
    return step.run("send", async () => {
      const target = await resolveSignupTarget(serviceClient(), tenant_id, user_id ?? null);
      if (!target) return { sent: false as const, reason: "tenant_not_found" };
      return sendSignupFollowup(target.tenant, target.user_id);
    });
  },
);
