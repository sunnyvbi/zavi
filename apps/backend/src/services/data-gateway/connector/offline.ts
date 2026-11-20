import { asTenantId, tenantRpc } from "@/services/tenant-client";
import { logEvent } from "@/services/logging/logEvent";
import { sgSend } from "@/email/sendAuthEmail";
import { webOrigin } from "@/email/theme";
import { renderConnectorOfflineEmail } from "@/email/templates/connector-offline";
import { noteOffline } from "../run-reads";
import type { GatewayContext } from "../types";
import { ageText, type ConnectorRow } from "./status";

export type OfflineDeps = {
  rpc: typeof tenantRpc;
  send: typeof sgSend;
  log: typeof logEvent;
};
const DEFAULT: OfflineDeps = { rpc: (...a) => tenantRpc(...a), send: (...a) => sgSend(...a), log: (i) => logEvent(i) };

export async function handleConnectorOffline(
  ctx: GatewayContext,
  row: Pick<ConnectorRow, "machine_name" | "last_seen_at"> | null,
  deps: Partial<OfflineDeps> = {},
): Promise<void> {
  const d = { ...DEFAULT, ...deps };
  const c = ctx.caller;
  await d.log({
    level: "warn",
    source: "data-gateway.connector",
    code: "connector_offline",
    tenant_id: ctx.tenant_id,
    run_id: c.kind === "agent" ? c.run_id : null,
    meta: { stage: c.kind, ...(c.kind === "agent" && c.agent_slug ? { agent_slug: c.agent_slug } : {}) },
  });
  if (c.kind === "agent") {
    noteOffline(c.run_id, row?.machine_name ?? null, row?.last_seen_at ?? null);
    return;
  }
  if (c.kind !== "background") return;
  await notifyBackgroundSkip(ctx.tenant_id, c.feature, d);
}

async function notifyBackgroundSkip(tenant_id: string, feature: string, d: OfflineDeps): Promise<void> {
  let claim: { notice_id?: string; should_send?: boolean; machine_name?: string | null; last_seen_at?: string | null } | undefined;
  try {
    const { data, error } = await d.rpc(asTenantId(tenant_id), "claim_db_connector_offline_notice", { p_feature: feature });
    if (error) throw new Error(error.message);
    claim = Array.isArray(data) ? (data[0] as typeof claim) : undefined;
  } catch (e) {
    await d.log({ level: "error", source: "data-gateway.connector", code: "connector_offline_claim_failed", tenant_id, error: e });
    return;
  }
  if (!claim?.notice_id || !claim.should_send) return;
  await deliverOfflineNotice({ tenant_id, notice_id: claim.notice_id, feature, machine: claim.machine_name ?? null, last_seen_at: claim.last_seen_at ?? null }, d);
}

export type OfflineNotice = { tenant_id: string; notice_id: string; feature: string; machine: string | null; last_seen_at: string | null };

export async function deliverOfflineNotice(n: OfflineNotice, deps: Partial<OfflineDeps> = {}): Promise<number> {
  const d = { ...DEFAULT, ...deps };
  const tid = asTenantId(n.tenant_id);
  const ack = async (delivered: number, error: string | null) => {
    try {
      const { error: ackErr } = await d.rpc(tid, "ack_db_connector_offline_notice", { p_notice_id: n.notice_id, p_delivered: delivered, p_error: error });
      if (ackErr) throw new Error(ackErr.message);
    } catch (e) {
      await d.log({ level: "error", source: "data-gateway.connector", code: "connector_offline_ack_failed", tenant_id: n.tenant_id, error: e });
    }
  };
  let to: string[] = [];
  try {
    const { data: emails, error: emailErr } = await d.rpc(tid, "tenant_admin_emails", {});
    if (emailErr) throw new Error(emailErr.message);
    to = Array.isArray(emails) ? (emails as unknown[]).filter((e): e is string => typeof e === "string" && e.includes("@")) : [];
  } catch (e) {
    await d.log({ level: "error", source: "data-gateway.connector", code: "connector_offline_recipients_failed", tenant_id: n.tenant_id, error: e });
    await ack(0, "recipient lookup failed");
    return 0;
  }
  if (to.length === 0) {
    await d.log({ level: "warn", source: "data-gateway.connector", code: "connector_offline_no_recipients", tenant_id: n.tenant_id });
    await ack(0, "no owner or admin email");
    return 0;
  }
  const rendered = renderConnectorOfflineEmail({
    feature: n.feature,
    machine: n.machine,
    lastSeenAge: ageText(n.last_seen_at),
    link: `${webOrigin()}/workspace?tab=brain#integrations`,
  });
  let sent = 0;
  for (const addr of to) {
    try {
      await d.send(addr, rendered.subject, rendered.html, rendered.text, undefined, { noTracking: true });
      sent += 1;
    } catch (e) {
      await d.log({ level: "warn", source: "data-gateway.connector", code: "connector_offline_send_failed", tenant_id: n.tenant_id, error: e });
    }
  }
  await ack(sent, sent > 0 ? null : "every send failed");
  await d.log({ level: sent > 0 ? "info" : "error", source: "data-gateway.connector", code: sent > 0 ? "connector_offline_notified" : "connector_offline_unsent", tenant_id: n.tenant_id, meta: { count: sent, total: to.length } });
  return sent;
}
