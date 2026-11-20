
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  resolveSlackApprover,
  linkSlackMemberOnMessage,
  type UsersInfoFn,
} from "@/services/slack/resolve-member";

export type ActorSource =
  | "chat"
  | "slack"
  | "approval"
  | "cron"
  | "system";

export type ActorAuthorityEnvelopeV1 = {
  actor_user_id: string | null;
  actor_source: ActorSource;
  slack_user_id?: string;
  slack_team_id?: string;
  resolved_tenant_member: boolean;
  provenance_label: string;
};

export function systemActor(source: Extract<ActorSource, "cron" | "system"> = "system"): ActorAuthorityEnvelopeV1 {
  return {
    actor_user_id: null,
    actor_source: source,
    resolved_tenant_member: false,
    provenance_label: source === "cron" ? "scheduled run" : "system",
  };
}

export function chatActor(userId: string | null | undefined): ActorAuthorityEnvelopeV1 {
  const uid = typeof userId === "string" && userId ? userId : null;
  return {
    actor_user_id: uid,
    actor_source: "chat",
    resolved_tenant_member: uid != null,
    provenance_label: uid ? "signed-in user" : "unknown",
  };
}

export async function resolveSlackActor(
  svc: SupabaseClient,
  tenant_id: string,
  slack_user_id: string | null | undefined,
  slack_team_id?: string | null,
  opts?: { linkOnMiss?: boolean; usersInfo?: UsersInfoFn },
): Promise<ActorAuthorityEnvelopeV1> {
  const uid = typeof slack_user_id === "string" ? slack_user_id.trim() : "";
  const base: ActorAuthorityEnvelopeV1 = {
    actor_user_id: null,
    actor_source: "slack",
    ...(uid ? { slack_user_id: uid } : {}),
    ...(slack_team_id ? { slack_team_id } : {}),
    resolved_tenant_member: false,
    provenance_label: "unverified external",
  };
  if (!uid || !tenant_id) return base;

  try {
    const who = { tenant_id, team_id: slack_team_id, slack_user_id: uid };
    let actorUserId = await resolveSlackApprover(svc, who);
    if (!actorUserId && opts?.linkOnMiss) {
      actorUserId = await linkSlackMemberOnMessage(svc, who, opts.usersInfo);
    }
    if (!actorUserId) return base;
    return {
      ...base,
      actor_user_id: actorUserId,
      resolved_tenant_member: true,
      provenance_label: "verified member",
    };
  } catch {
    return base;
  }
}

export async function buildRunActor(
  svc: SupabaseClient,
  trigger: string,
  opts: {
    tenant_id: string;
    enqueued_by?: string | null;
    slack_user_id?: string | null;
    slack_team_id?: string | null;
    inherited_actor?: unknown;
    link_slack_on_miss?: boolean;
  },
): Promise<ActorAuthorityEnvelopeV1> {
  if (trigger === "chat") return chatActor(opts.enqueued_by);
  if (trigger === "slack") {
    return resolveSlackActor(svc, opts.tenant_id, opts.slack_user_id, opts.slack_team_id, {
      linkOnMiss: opts.link_slack_on_miss === true,
    });
  }
  const inherited = coerceInheritedActor(opts.inherited_actor);
  if (inherited) return inherited;
  return systemActor(trigger === "cron" || trigger === "scheduled" ? "cron" : "system");
}

export function coerceInheritedActor(raw: unknown): ActorAuthorityEnvelopeV1 | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const sources: ActorSource[] = ["chat", "slack", "approval", "cron", "system"];
  if (typeof o.actor_source !== "string" || !sources.includes(o.actor_source as ActorSource)) {
    return null;
  }
  if (o.actor_user_id !== null && typeof o.actor_user_id !== "string") return null;
  if (typeof o.resolved_tenant_member !== "boolean") return null;
  if (typeof o.provenance_label !== "string") return null;
  return {
    actor_user_id: (o.actor_user_id as string | null) ?? null,
    actor_source: o.actor_source as ActorSource,
    ...(typeof o.slack_user_id === "string" ? { slack_user_id: o.slack_user_id } : {}),
    ...(typeof o.slack_team_id === "string" ? { slack_team_id: o.slack_team_id } : {}),
    resolved_tenant_member: o.resolved_tenant_member as boolean,
    provenance_label: o.provenance_label as string,
  };
}

const strField = (o: unknown, k: string): string =>
  o && typeof o === "object" && typeof (o as Record<string, unknown>)[k] === "string"
    ? ((o as Record<string, unknown>)[k] as string).trim()
    : "";

export async function resolveEmailActor(
  svc: SupabaseClient,
  tenant_id: string,
  payload: unknown,
): Promise<string | null> {
  const messageId = strField((payload as { email?: unknown } | null)?.email, "email_message_id");
  if (!messageId || !tenant_id) return null;
  try {
    const { data: msg } = await svc
      .from("email_messages")
      .select("direction, sender_verified_member, from_address")
      .eq("tenant_id", tenant_id)
      .eq("id", messageId)
      .maybeSingle();
    const m = msg as { direction?: string; sender_verified_member?: boolean; from_address?: string | null } | null;
    if (!m || m.direction !== "in" || m.sender_verified_member !== true || !m.from_address) return null;
    const { data: userId } = await svc.rpc("member_user_id_by_email", {
      p_tenant_id: tenant_id,
      p_email: m.from_address,
    });
    return typeof userId === "string" && userId ? userId : null;
  } catch {
    return null;
  }
}

export async function resolveWhatsAppActor(
  svc: SupabaseClient,
  tenant_id: string,
  payload: unknown,
): Promise<string | null> {
  const wa = (payload as { whatsapp?: unknown } | null)?.whatsapp;
  const phoneNumberId = strField(wa, "phone_number_id");
  const waId = strField(wa, "wa_id");
  if (!phoneNumberId || !waId || !tenant_id) return null;
  try {
    const { data: thread } = await svc
      .from("whatsapp_threads")
      .select("bound_by_user_id, status")
      .eq("tenant_id", tenant_id)
      .eq("phone_number_id", phoneNumberId)
      .eq("wa_id", waId)
      .maybeSingle();
    const t = thread as { bound_by_user_id?: string | null; status?: string } | null;
    if (!t || t.status !== "enabled" || !t.bound_by_user_id) return null;
    const { data: member } = await svc
      .from("tenant_users")
      .select("user_id")
      .eq("tenant_id", tenant_id)
      .eq("user_id", t.bound_by_user_id)
      .maybeSingle();
    const u = member as { user_id?: string } | null;
    return u?.user_id ?? null;
  } catch {
    return null;
  }
}
