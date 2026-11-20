
import { asTenantId, tenantClient, preTenantRpc } from "@/services/tenant-client";
import { loadTenantRoleFor } from "@/services/auth/tenant-role";
import { logEvent } from "@/services/logging/logEvent";
import { loadHumanMemberByAuthUser } from "./member";
import { scrubContact } from "@/services/creators/contact-scrub";

export const MAX_MESSAGE_LEN = 4000;

export type SenderKind = "tenant" | "human_member";

export type ThreadAccess = {
  tenant_id: string;
  application_id: string;
  sender_kind: SenderKind;
  tenant_role?: string;
};

export type ThreadAccessResult =
  | { ok: true; access: ThreadAccess }
  | { ok: false; code: "application_not_found" | "not_authorized" };

type ApplicationRef = {
  tenant_id: string;
  brief_kind: string;
  brief_id: string;
  human_member_id: string;
  status: string;
};

export async function authorizeThreadAccess(args: {
  auth_user_id: string;
  application_id: string;
}): Promise<ThreadAccessResult> {
  const { data, error } = await preTenantRpc("human_resolve_application", {
    p_application_id: args.application_id,
  });
  if (error) throw new Error(`human_resolve_application failed: ${error.message}`);
  const rows = (data ?? []) as ApplicationRef[];
  if (rows.length === 0) return { ok: false, code: "application_not_found" };
  const application = rows[0];

  const member = await loadHumanMemberByAuthUser(args.auth_user_id);
  if (member && member.id === application.human_member_id) {
    return {
      ok: true,
      access: {
        tenant_id: application.tenant_id,
        application_id: args.application_id,
        sender_kind: "human_member",
      },
    };
  }

  const role = await loadTenantRoleFor(args.auth_user_id, application.tenant_id);
  if (role) {
    return {
      ok: true,
      access: {
        tenant_id: application.tenant_id,
        application_id: args.application_id,
        sender_kind: "tenant",
        tenant_role: role,
      },
    };
  }

  return { ok: false, code: "not_authorized" };
}

export type ThreadMessage = {
  id: string;
  sender_kind: SenderKind;
  body: string;
  created_at: string;
};

export async function listThreadMessages(access: ThreadAccess): Promise<ThreadMessage[]> {
  const { data, error } = await tenantClient(asTenantId(access.tenant_id))
    .from("engagement_messages")
    .select("id, sender_kind, body, created_at")
    .eq("application_id", access.application_id)
    .order("created_at", { ascending: true })
    .limit(500);
  if (error) throw new Error(`engagement_messages read failed: ${error.message}`);
  return (data ?? []) as ThreadMessage[];
}

const CONTACT_PATTERNS: RegExp[] = [
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
  /(?:\+?\d[\s().-]?){9,}\d/,
  /\b(?:wa\.me|t\.me|telegram|whatsapp|signal\.me|calendly\.com|discord\.gg)\b/i,
];

export function looksLikeContactExchange(body: string): boolean {
  return CONTACT_PATTERNS.some((re) => re.test(body));
}

export async function postThreadMessage(args: {
  access: ThreadAccess;
  sender_user_id: string;
  body: string;
}): Promise<ThreadMessage> {
  const { access } = args;
  const { data, error } = await tenantClient(asTenantId(access.tenant_id))
    .from("engagement_messages")
    .insert({
      application_id: access.application_id,
      sender_kind: access.sender_kind,
      sender_user_id: args.sender_user_id,
      body: scrubContact(args.body).body,
    })
    .select("id, sender_kind, body, created_at")
    .maybeSingle();
  if (error || !data) {
    throw new Error(`engagement_messages insert failed: ${error?.message ?? "no row"}`);
  }

  if (looksLikeContactExchange(args.body)) {
    void logEvent({
      level: "info",
      source: "human/thread",
      code: "human.contact_exchanged",
      message: `contact details shared by ${access.sender_kind}`,
      tenant_id: access.tenant_id,
    }).catch(() => undefined);
  }

  return data as ThreadMessage;
}
