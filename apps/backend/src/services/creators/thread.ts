
import { asTenantId, tenantClient, preTenantRpc, globalClient } from "@/services/tenant-client";
import { loadTenantRoleFor } from "@/services/auth/tenant-role";
import { logEvent } from "@/services/logging/logEvent";
import { loadHumanMemberByAuthUser } from "@/services/humans/member";
import { scrubContact } from "./contact-scrub";
import { notifyThreadMessage } from "./thread-notify";

export const MAX_CREATOR_MESSAGE_LEN = 4000;

export type CreatorSenderKind = "tenant" | "creator";

export type CreatorThreadAccess = {
  tenant_id: string;
  thread_id: string;
  human_member_id: string;
  sender_kind: CreatorSenderKind;
  tenant_role?: string;
};

export type CreatorThreadAccessResult =
  | { ok: true; access: CreatorThreadAccess }
  | { ok: false; code: "thread_not_found" | "not_authorized" };

type ThreadRef = {
  tenant_id: string;
  human_member_id: string;
  started_by: string;
};

export async function authorizeCreatorThreadAccess(args: {
  auth_user_id: string;
  thread_id: string;
}): Promise<CreatorThreadAccessResult> {
  const { data, error } = await preTenantRpc("creator_resolve_thread", {
    p_thread_id: args.thread_id,
  });
  if (error) throw new Error(`creator_resolve_thread failed: ${error.message}`);
  const rows = (data ?? []) as ThreadRef[];
  if (rows.length === 0) return { ok: false, code: "thread_not_found" };
  const thread = rows[0];

  return resolveSide({
    auth_user_id: args.auth_user_id,
    tenant_id: thread.tenant_id,
    human_member_id: thread.human_member_id,
    thread_id: args.thread_id,
  });
}

export async function resolveSide(args: {
  auth_user_id: string;
  tenant_id: string;
  human_member_id: string;
  thread_id: string;
}): Promise<CreatorThreadAccessResult> {
  const member = await loadHumanMemberByAuthUser(args.auth_user_id);
  if (member && member.id === args.human_member_id) {
    return {
      ok: true,
      access: {
        tenant_id: args.tenant_id,
        thread_id: args.thread_id,
        human_member_id: args.human_member_id,
        sender_kind: "creator",
      },
    };
  }

  const role = await loadTenantRoleFor(args.auth_user_id, args.tenant_id);
  if (role) {
    return {
      ok: true,
      access: {
        tenant_id: args.tenant_id,
        thread_id: args.thread_id,
        human_member_id: args.human_member_id,
        sender_kind: "tenant",
        tenant_role: role,
      },
    };
  }

  return { ok: false, code: "not_authorized" };
}

export async function isBookableCreator(human_member_id: string): Promise<boolean> {
  const { data, error } = await globalClient()
    .from("human_members")
    .select("id, vetting_state")
    .eq("id", human_member_id)
    .maybeSingle();
  if (error) throw new Error(`human_members read failed: ${error.message}`);
  return (data as { vetting_state?: string } | null)?.vetting_state === "approved";
}

export type CreatorThreadMessage = {
  id: string;
  sender_kind: string;
  body: string;
  created_at: string;
};

export type CreatorThreadRow = {
  id: string;
  tenant_id: string;
  human_member_id: string;
  started_by: string;
  last_message_at: string | null;
  created_at: string;
};

export async function ensureCreatorThread(args: {
  tenant_id: string;
  human_member_id: string;
  started_by: CreatorSenderKind;
  started_by_user_id: string | null;
}): Promise<CreatorThreadRow> {
  const client = tenantClient(asTenantId(args.tenant_id));

  const existing = await client
    .from("creator_threads")
    .select("id, tenant_id, human_member_id, started_by, last_message_at, created_at")
    .eq("human_member_id", args.human_member_id)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (existing.error) {
    throw new Error(`creator_threads read failed: ${existing.error.message}`);
  }
  if (existing.data) return existing.data as CreatorThreadRow;

  const created = await client
    .from("creator_threads")
    .insert({
      human_member_id: args.human_member_id,
      started_by: args.started_by,
      started_by_user_id: args.started_by_user_id,
    })
    .select("id, tenant_id, human_member_id, started_by, last_message_at, created_at")
    .maybeSingle();
  if (created.error || !created.data) {
    throw new Error(`creator_threads insert failed: ${created.error?.message ?? "no row"}`);
  }
  return created.data as CreatorThreadRow;
}

export async function listCreatorThreadMessages(
  access: CreatorThreadAccess,
): Promise<CreatorThreadMessage[]> {
  const { data, error } = await tenantClient(asTenantId(access.tenant_id))
    .from("creator_thread_messages")
    .select("id, sender_kind, body, created_at")
    .eq("thread_id", access.thread_id)
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) throw new Error(`creator_thread_messages read failed: ${error.message}`);
  return [...((data ?? []) as CreatorThreadMessage[])].reverse();
}

export async function postCreatorThreadMessage(args: {
  access: CreatorThreadAccess;
  sender_user_id: string | null;
  body: string;
}): Promise<CreatorThreadMessage> {
  const { access } = args;
  const scrubbed = scrubContact(args.body);

  const client = tenantClient(asTenantId(access.tenant_id));
  const { data, error } = await client
    .from("creator_thread_messages")
    .insert({
      thread_id: access.thread_id,
      sender_kind: access.sender_kind,
      sender_user_id: args.sender_user_id,
      body: scrubbed.body,
    })
    .select("id, sender_kind, body, created_at")
    .maybeSingle();
  if (error || !data) {
    throw new Error(`creator_thread_messages insert failed: ${error?.message ?? "no row"}`);
  }

  void client
    .from("creator_threads")
    .update({ last_message_at: (data as CreatorThreadMessage).created_at, updated_at: new Date().toISOString() })
    .eq("id", access.thread_id)
    .then(undefined, () => undefined);

  void notifyThreadMessage({
    tenant_id: access.tenant_id,
    human_member_id: access.human_member_id,
    thread_id: access.thread_id,
    from: access.sender_kind,
    body: (data as CreatorThreadMessage).body,
  }).catch(() => undefined);

  if (scrubbed.removed.length > 0) {
    void logEvent({
      level: "info",
      source: "creators/thread",
      code: "creator.contact_scrubbed",
      message: `contact details removed from a ${access.sender_kind} message (${scrubbed.removed.join(", ")})`,
      tenant_id: access.tenant_id,
    }).catch(() => undefined);
  }

  return data as CreatorThreadMessage;
}
