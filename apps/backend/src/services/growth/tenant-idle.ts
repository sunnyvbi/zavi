
import { asTenantId, staffCrossTenantClient, tenantClient } from "@/services/tenant-client";

export const IDLE_DAYS = 7;

export const WORKSPACE_OPENED_CODE = "workspace.opened";

export const PERSON_TRIGGERS = [
  "chat",
  "manual",
  "slack",
  "mcp",
  "email",
  "whatsapp",
  "imessage",
  "telegram",
  "teams",
  "discord",
] as const;

const FOUNDER_DECIDED = "approved_by_source.is.null,approved_by_source.eq.email";

type Read = PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;

function activityReads(tenant_id: string, since: string): Record<string, Read> {
  const db = tenantClient(asTenantId(tenant_id));
  return {
    chat: db
      .from("agent_thread_messages")
      .select("id")
      .eq("tenant_id", tenant_id)
      .eq("sender_role", "user")
      .gte("created_at", since)
      .limit(1),
    runs: db
      .from("agent_runs")
      .select("id")
      .eq("tenant_id", tenant_id)
      .gte("enqueued_at", since)
      .or(`actor_user_id.not.is.null,trigger.in.(${PERSON_TRIGGERS.join(",")})`)
      .limit(1),
    workspace_open: staffCrossTenantClient("idle check: one tenant's workspace-open log rows")
      .from("praxis_logs")
      .select("id")
      .eq("tenant_id", tenant_id)
      .gte("created_at", since)
      .eq("code", WORKSPACE_OPENED_CODE)
      .limit(1),
    card_action: db
      .from("channel_action_events")
      .select("action_id")
      .eq("tenant_id", tenant_id)
      .eq("actor_kind", "founder")
      .gte("at", since)
      .limit(1),
    approved: db
      .from("decisions")
      .select("id")
      .eq("tenant_id", tenant_id)
      .not("approved_by", "is", null)
      .or(FOUNDER_DECIDED)
      .gte("approved_at", since)
      .limit(1),
    rejected: founderRejections(tenant_id, since),
    channel_open: db
      .from("tenant_channels")
      .select("channel_slug")
      .eq("tenant_id", tenant_id)
      .gte("founder_seen_at", since)
      .limit(1),
    answered: db
      .from("cgo_questions")
      .select("id")
      .eq("tenant_id", tenant_id)
      .gte("answered_at", since)
      .limit(1),
  };
}

const STAFF_ROSTER_MAX = 200;

async function founderRejections(tenant_id: string, since: string): Promise<{ data: unknown[] | null; error: { message: string } | null }> {
  const rejections = (notBy: readonly string[]) => {
    let q = tenantClient(asTenantId(tenant_id))
      .from("decisions")
      .select("id")
      .eq("tenant_id", tenant_id)
      .not("rejected_by", "is", null)
      .or(FOUNDER_DECIDED)
      .gte("rejected_at", since);
    if (notBy.length > 0) q = q.not("rejected_by", "in", `(${notBy.join(",")})`);
    return q.limit(1);
  };
  const any = await rejections([]);
  if (any.error || (any.data ?? []).length === 0) return any;
  const staff = await staffCrossTenantClient("idle check: staff ids, to tell a staff reject from the founder's")
    .from("staff_users")
    .select("user_id")
    .limit(STAFF_ROSTER_MAX);
  if (staff.error) return { data: null, error: staff.error };
  const ids = ((staff.data ?? []) as Array<{ user_id: string }>).map((r) => r.user_id);
  if (ids.length >= STAFF_ROSTER_MAX) return { data: null, error: { message: "staff roster too large to read whole" } };
  return ids.length === 0 ? any : rejections(ids);
}

export async function tenantIsIdle(tenant_id: string, now: Date = new Date()): Promise<boolean> {
  try {
    const since = new Date(now.getTime() - IDLE_DAYS * 86_400_000).toISOString();
    const entries = Object.entries(activityReads(tenant_id, since));
    const results = await Promise.all(entries.map(([, r]) => r));
    for (let i = 0; i < results.length; i += 1) {
      const r = results[i]!;
      if (r.error) {
        console.warn(`[tenant-idle] ${entries[i]![0]} read failed for ${tenant_id}; counting as active: ${r.error.message}`);
        return false;
      }
      if ((r.data ?? []).length > 0) return false;
    }
    return true;
  } catch (e) {
    console.warn(`[tenant-idle] check failed for ${tenant_id}; counting as active: ${(e as Error).message}`);
    return false;
  }
}
