
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { getBoolSettingStrictResolved } from "@/services/settings";
import { BULK_NOT_CONFIGURED_CODE, BULK_NOT_CONFIGURED_SENTENCE, bulkSendgridKey, bulkSendingStoppedGlobally } from "./config";
import { recheckSendingDomainIfStale, resolveBulkSender, type BulkSender } from "./sending-domain";
import { getEmailTemplate } from "@/services/email-templates/store";
import { isPlaceholderPostalAddress } from "./postal-address";

export type BulkRefusalCode =
  | "bulk_outbound_disabled"
  | "bulk_sending_paused"
  | typeof BULK_NOT_CONFIGURED_CODE
  | "sending_domain_not_verified"
  | "postal_address_missing"
  | "postal_address_placeholder"
  | "workspace_closed"
  | "bulk_abuse_hold"
  | "list_not_found"
  | "list_archived"
  | "list_not_consented"
  | "list_empty"
  | "bulk_check_failed";

export const BULK_REFUSAL_SENTENCES: Record<BulkRefusalCode, string> = {
  bulk_outbound_disabled: "Bulk email is switched off for this workspace.",
  bulk_sending_paused: "Zavi's own sender is stopped for every workspace right now, so no email can go out from it. Try again once it is running.",
  [BULK_NOT_CONFIGURED_CODE]: BULK_NOT_CONFIGURED_SENTENCE,
  sending_domain_not_verified:
    "Your sending domain is not verified yet, so bulk email cannot go out. In Email campaigns settings, add it if it is not there, then publish the DNS records shown for it and check it again.",
  postal_address_missing:
    "Add your business postal address in Email campaigns settings. Every bulk email has to show it.",
  postal_address_placeholder:
    "Your business postal address in Email campaigns settings is still a placeholder. Replace it with your real postal address, because every bulk email has to show it.",
  workspace_closed: "This workspace is closed.",
  bulk_abuse_hold:
    "Bulk email is paused for this workspace because too many people marked a recent email as spam or it bounced. Contact support to switch it back on.",
  list_not_found: "That contact list was not found.",
  list_archived: "That contact list was archived.",
  list_not_consented:
    "Nobody has confirmed that the people on this list agreed to hear from you. Confirm it in Email campaigns settings.",
  list_empty: "There is nobody on this list who can be emailed.",
  bulk_check_failed: "We could not check whether bulk email is ready. Try again.",
};

export type BulkRefusal = { ok: false; code: BulkRefusalCode; sentence: string };
export type BulkSenderReady = { ok: true; sender: BulkSender; postal_address: string };

function refuse(code: BulkRefusalCode): BulkRefusal {
  return { ok: false, code, sentence: BULK_REFUSAL_SENTENCES[code] };
}

export async function readEmailSettingText(tenantId: string, fieldId: string): Promise<string | null> {
  const { data, error } = await tenantRpc(asTenantId(tenantId), "get_channel_settings", {
    p_channel_slug: "email_marketing",
  });
  if (error) throw new Error("get_channel_settings failed");
  const items = ((data as { fields?: Record<string, unknown> } | null)?.fields ?? {})[fieldId];
  if (!Array.isArray(items)) return null;
  for (const raw of items) {
    const row = raw as { item?: unknown; status?: unknown } | null;
    if (!row || row.status === "dismissed" || row.status === "paused") continue;
    const text = typeof row.item === "string" ? row.item.trim() : "";
    if (text) return text.slice(0, 500);
  }
  return null;
}

export async function readPostalAddress(tenantId: string): Promise<string | null> {
  const stored = await getEmailTemplate(asTenantId(tenantId));
  if (!stored) return readEmailSettingText(tenantId, "postal_address");
  const template = stored.postal_address?.trim() ?? "";
  return template ? template.slice(0, 500) : null;
}

export async function checkBulkSender(tenantId: string): Promise<BulkSenderReady | BulkRefusal> {
  try {
    if (!(await getBoolSettingStrictResolved("bulk_outbound_enabled", tenantId))) {
      const { data: openHold } = await tenantClient(asTenantId(tenantId))
        .from("email_bulk_abuse_holds")
        .select("reason, cleared_at")
        .maybeSingle();
      if (openHold && !(openHold as { cleared_at: string | null }).cleared_at) return refuse("bulk_abuse_hold");
      return refuse("bulk_outbound_disabled");
    }
    if (await bulkSendingStoppedGlobally()) return refuse("bulk_sending_paused");
    if (!bulkSendgridKey()) return refuse(BULK_NOT_CONFIGURED_CODE);

    const { data: tenant, error: tenantErr } = await tenantClient(asTenantId(tenantId))
      .from("tenants")
      .select("id, deleted_at")
      .maybeSingle();
    if (tenantErr) return refuse("bulk_check_failed");
    if (!tenant || (tenant as { deleted_at?: string | null }).deleted_at) return refuse("workspace_closed");

    const { data: hold, error: holdErr } = await tenantClient(asTenantId(tenantId))
      .from("email_bulk_abuse_holds")
      .select("reason, cleared_at")
      .maybeSingle();
    if (holdErr) return refuse("bulk_check_failed");
    if (hold && !(hold as { cleared_at: string | null }).cleared_at) return refuse("bulk_abuse_hold");

    await recheckSendingDomainIfStale(tenantId);
    const sender = await resolveBulkSender(tenantId);
    if (!sender) return refuse("sending_domain_not_verified");
    const postal_address = await readPostalAddress(tenantId);
    if (!postal_address) return refuse("postal_address_missing");
    if (isPlaceholderPostalAddress(postal_address)) return refuse("postal_address_placeholder");
    return { ok: true, sender, postal_address };
  } catch {
    return refuse("bulk_check_failed");
  }
}

export async function checkListVersion(
  tenantId: string,
  listId: string,
  versionId: string,
): Promise<{ ok: true; list_name: string } | BulkRefusal> {
  try {
    const db = tenantClient(asTenantId(tenantId));
    const { data: list, error: listErr } = await db
      .from("email_lists")
      .select("id, name, archived_at")
      .eq("id", listId)
      .maybeSingle();
    if (listErr) return refuse("bulk_check_failed");
    if (!list) return refuse("list_not_found");
    const l = list as { name: string; archived_at: string | null };
    if (l.archived_at) return refuse("list_archived");

    const { data: version, error: versionErr } = await db
      .from("email_list_versions")
      .select("id, list_id, consent_confirmed_at")
      .eq("id", versionId)
      .eq("list_id", listId)
      .maybeSingle();
    if (versionErr) return refuse("bulk_check_failed");
    if (!version) return refuse("list_not_found");
    if (!(version as { consent_confirmed_at: string | null }).consent_confirmed_at) return refuse("list_not_consented");
    return { ok: true, list_name: l.name };
  } catch {
    return refuse("bulk_check_failed");
  }
}

export async function checkBulkReady(
  tenantId: string,
  listId: string,
  versionId: string,
): Promise<(BulkSenderReady & { list_name: string }) | BulkRefusal> {
  const sender = await checkBulkSender(tenantId);
  if (!sender.ok) return sender;
  const list = await checkListVersion(tenantId, listId, versionId);
  if (!list.ok) return list;
  return { ...sender, list_name: list.list_name };
}
