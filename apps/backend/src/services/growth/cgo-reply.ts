
import { asTenantId, tenantClient } from "@/services/tenant-client";
import type { FounderReply } from "./goal-owner";

const MAX_REPLY_CHARS = 2000;

export type CgoReplyMarker = { via: "email" | "slack" };

export function cgoReplyMarker(payload: unknown): CgoReplyMarker | null {
  const via = (payload as { cgo_reply?: { via?: unknown } } | null)?.cgo_reply?.via;
  return via === "email" || via === "slack" ? { via } : null;
}

export async function founderReplyFromRun(args: {
  tenant_id: string;
  run_id: string;
  trigger: string | null | undefined;
  payload: unknown;
}): Promise<FounderReply | null> {
  const marker = cgoReplyMarker(args.payload);
  if (!marker) return null;
  try {
    if (marker.via === "email") {
      if (args.trigger !== "email") return null;
      const id = (args.payload as { email?: { email_message_id?: unknown } }).email?.email_message_id;
      if (typeof id !== "string") return null;
      const text = await verifiedFounderEmailText(args.tenant_id, id);
      return text ? { via: "email", text: text.slice(0, MAX_REPLY_CHARS), reply_run_id: args.run_id } : null;
    }

    if (args.trigger !== "slack") return null;
    const slack = (args.payload as { slack?: { user?: unknown; team_id?: unknown; text?: unknown } }).slack;
    const user = typeof slack?.user === "string" ? slack.user : "";
    const team = typeof slack?.team_id === "string" && slack.team_id ? slack.team_id : undefined;
    const text = typeof slack?.text === "string" ? slack.text.trim() : "";
    if (!user || !text) return null;
    const { resolveTenantOwnerEmail } = await import("@/email/sendAuthEmail");
    const email = await resolveTenantOwnerEmail(args.tenant_id);
    if (!email) return null;
    const { slackFetch } = await import("@/services/tools/slack/_client");
    const who = await slackFetch<{ user?: { id?: string } }>(args.tenant_id, "users.lookupByEmail", { email }, team);
    if (who.user?.id !== user) return null;
    return { via: "slack", text: text.slice(0, MAX_REPLY_CHARS), reply_run_id: args.run_id };
  } catch (e) {
    console.warn(`[cgo-reply] founder check failed for run ${args.run_id}: ${(e as Error).message}`);
    return null;
  }
}

export async function verifiedFounderEmailText(tenant_id: string, email_message_id: string): Promise<string | null> {
  try {
    const { isVerifiedMemberReplyRun } = await import("@/services/agents/email-reply-trust");
    const ok = await isVerifiedMemberReplyRun({ tenant_id, agent_slug: "cgo", trigger: "email", payload: { email: { email_message_id } } });
    if (!ok) return null;
    const { data } = await tenantClient(asTenantId(tenant_id))
      .from("email_messages")
      .select("body_text, from_address")
      .eq("id", email_message_id)
      .eq("tenant_id", tenant_id)
      .maybeSingle<{ body_text: string | null; from_address: string | null }>();
    const { resolveTenantOwnerEmail } = await import("@/email/sendAuthEmail");
    const { parseAddrSpec } = await import("@/email/addr-spec");
    const owner = parseAddrSpec(await resolveTenantOwnerEmail(tenant_id))?.address;
    const from = parseAddrSpec(data?.from_address ?? "")?.address;
    if (!owner || !from || owner !== from) return null;
    const { splitReplyText } = await import("@/email/quoted-reply");
    return splitReplyText(data?.body_text ?? "").own.trim() || null;
  } catch (e) {
    console.warn(`[cgo-reply] founder email check failed: ${(e as Error).message}`);
    return null;
  }
}
