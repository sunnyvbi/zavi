
import type { Request, Response } from "express";
import crypto from "node:crypto";
import { suppressEmail } from "@/services/tools/email/safety-net";
import { staffCrossTenantClient } from "@/services/tenant-client";
import { logEvent, logEventConfirmed } from "@/services/logging/logEvent";
import { markInviteBounced } from "@/services/creators/creator-invites";
import { bulkFeedbackKind, recordBulkFeedback, resolveBulkRecipientTenant } from "@/services/comms/bulk-outbound/feedback";

const ADDRESS_DROP_REASONS = new Map<string, "bounce" | "complaint" | "unsubscribe">([
  ["bounced address", "bounce"],
  ["invalid", "bounce"],
  ["unsubscribed address", "unsubscribe"],
  ["spam reporting address", "complaint"],
]);

export function suppressionReason(ev: { event?: string; type?: string; reason?: string }): "bounce" | "complaint" | "unsubscribe" | null {
  const name = String(ev.event ?? "").toLowerCase();
  if (name === "spamreport") return "complaint";
  if (name === "bounce") return String(ev.type ?? "bounce").trim().toLowerCase() === "blocked" ? null : "bounce";
  if (name === "dropped") return ADDRESS_DROP_REASONS.get(String(ev.reason ?? "").trim().toLowerCase()) ?? null;
  return null;
}

const MAX_SKEW_SECONDS = 10 * 60;

interface SendGridEvent {
  email?: string;
  event?: string;
  timestamp?: number;
  sg_event_id?: string;
  tenant_id?: string;
  creator_invite_id?: string;
  bulk_send_id?: string;
  type?: string;
  reason?: string;
  sg_machine_open?: boolean;
}

export type BulkEngagementEvent = { id: string; tenant_id: string; send_id: string; kind: "delivered" | "open" | "machine_open" | "click" };

export function bulkEngagementEvents(events: SendGridEvent[]): BulkEngagementEvent[] {
  const out: BulkEngagementEvent[] = [];
  for (const ev of events) {
    const name = String(ev.event ?? "").toLowerCase();
    if (name !== "delivered" && name !== "open" && name !== "click") continue;
    const id = typeof ev.sg_event_id === "string" ? ev.sg_event_id.trim() : "";
    const tenant_id = typeof ev.tenant_id === "string" ? ev.tenant_id : "";
    const send_id = typeof ev.bulk_send_id === "string" ? ev.bulk_send_id : "";
    if (!id || id.length > 200 || !tenant_id || !send_id) continue;
    const kind = name === "open" && ev.sg_machine_open === true ? "machine_open" : (name as BulkEngagementEvent["kind"]);
    out.push({ id, tenant_id, send_id, kind });
  }
  return out;
}

export function verifySendGridSignature(
  publicKeyBase64: string,
  rawBody: Buffer,
  timestamp: string,
  signatureBase64: string,
): boolean {
  try {
    if (!publicKeyBase64 || !timestamp || !signatureBase64) return false;

    const key = crypto.createPublicKey({
      key: Buffer.from(
        `-----BEGIN PUBLIC KEY-----\n${publicKeyBase64}\n-----END PUBLIC KEY-----\n`,
      ),
      format: "pem",
    });

    const payload = Buffer.concat([Buffer.from(timestamp, "utf8"), rawBody]);
    return crypto.verify(
      "sha256",
      payload,
      { key, dsaEncoding: "der" },
      Buffer.from(signatureBase64, "base64"),
    );
  } catch {
    return false;
  }
}

export function sendgridWebhookPublicKeys(env: NodeJS.ProcessEnv = process.env): string[] {
  return [env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY, env.BULK_SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY]
    .map((k) => (k ?? "").trim())
    .filter((k) => k.length > 0);
}

export async function sendgridEventsWebhook(req: Request, res: Response): Promise<void> {
  const publicKeys = sendgridWebhookPublicKeys();
  if (publicKeys.length === 0) {
    res.status(503).json({
      error: {
        code: "webhook_not_configured",
        message: "SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY unset",
      },
    });
    return;
  }

  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));
  const signature = String(req.header("x-twilio-email-event-webhook-signature") ?? "");
  const timestamp = String(req.header("x-twilio-email-event-webhook-timestamp") ?? "");

  if (!publicKeys.some((key) => verifySendGridSignature(key, rawBody, timestamp, signature))) {
    res.status(403).json({ error: { code: "bad_signature", message: "signature verification failed" } });
    return;
  }

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > MAX_SKEW_SECONDS) {
    res.status(403).json({ error: { code: "stale_timestamp", message: "event timestamp outside accepted window" } });
    return;
  }

  let events: SendGridEvent[];
  try {
    const parsed: unknown = JSON.parse(rawBody.toString("utf8"));
    events = Array.isArray(parsed) ? (parsed as SendGridEvent[]) : [];
  } catch {
    res.status(400).json({ error: { code: "bad_payload", message: "body is not a JSON array" } });
    return;
  }

  const engagement = bulkEngagementEvents(events);
  if (engagement.length > 0) {
    const { error } = await staffCrossTenantClient("bulk email results: count delivered and open events per send (no address stored)").rpc(
      "email_bulk_record_events",
      { p_events: engagement },
    );
    if (error) {
      res.status(500).json({ error: { code: "engagement_write_failed", message: "retry the batch" } });
      return;
    }
  }

  let suppressed = 0;
  let skipped = 0;
  let unattributed = 0;
  let inviteBounces = 0;
  let inviteWriteFailed = false;
  let suppressionWriteFailed = false;
  const bulkDropped = new Map<string, { mismatch: number; unmatched: number; resolved: string | null }>();
  const sendOwner = new Map<string, string>();

  for (const ev of events) {
    const reason = suppressionReason(ev);
    if (!reason) {
      skipped++;
      continue;
    }

    const email = typeof ev.email === "string" ? ev.email.trim().toLowerCase() : "";
    if (!email) {
      skipped++;
      continue;
    }

    const invite_id = typeof ev.creator_invite_id === "string" ? ev.creator_invite_id : "";
    if (invite_id) {
      try {
        await markInviteBounced(invite_id, `${reason}: ${String(ev.reason ?? ev.type ?? "").slice(0, 150)}`);
        inviteBounces++;
      } catch {
        inviteWriteFailed = true;
      }
      continue;
    }

    const claimed = typeof ev.tenant_id === "string" ? ev.tenant_id : "";
    const bulk_send_id = typeof ev.bulk_send_id === "string" ? ev.bulk_send_id : "";
    let tenant_id = claimed;
    if (bulk_send_id) {
      let owner: string | null;
      try {
        owner = await resolveBulkRecipientTenant(bulk_send_id, email);
      } catch {
        suppressionWriteFailed = true;
        skipped++;
        continue;
      }
      if (owner) sendOwner.set(bulk_send_id, owner);
      if (!owner || (claimed && claimed !== owner)) {
        const d = bulkDropped.get(bulk_send_id) ?? { mismatch: 0, unmatched: 0, resolved: null };
        if (owner) d.mismatch++;
        else d.unmatched++;
        bulkDropped.set(bulk_send_id, d);
        skipped++;
        continue;
      }
      tenant_id = owner;
    }
    if (!tenant_id) {
      unattributed++;
      continue;
    }

    try {
      await suppressEmail(tenant_id, email, reason);
      suppressed++;
    } catch {
      suppressionWriteFailed = true;
      skipped++;
      continue;
    }

    const kind = bulk_send_id ? bulkFeedbackKind(String(ev.event ?? ""), ev.type) : null;
    if (kind) {
      try {
        await recordBulkFeedback({ tenantId: tenant_id, sendId: bulk_send_id, email, kind });
      } catch {
        suppressionWriteFailed = true;
      }
    }
  }

  if (inviteWriteFailed) {
    res.status(500).json({ error: { code: "invite_bounce_write_failed", message: "retry the batch" } });
    return;
  }
  if (suppressionWriteFailed) {
    res.status(500).json({ error: { code: "suppression_write_failed", message: "retry the batch" } });
    return;
  }

  for (const [sendId, d] of bulkDropped) d.resolved = sendOwner.get(sendId) ?? null;
  if (bulkDropped.size > 0 && !(await reportDroppedBulkEvents(bulkDropped))) {
    res.status(500).json({ error: { code: "alert_write_failed", message: "retry the batch" } });
    return;
  }

  if (unattributed > 0) {
    console.warn(
      `[sendgrid-events] ${unattributed} suppressing event(s) had no tenant_id — suppression skipped for them`,
    );
    await logEvent({
      level: "warn",
      source: "sendgrid-events",
      code: "email.suppression.unattributed",
      message: `${unattributed} suppressing event(s) arrived with no tenant_id`,
      meta: { unattributed, batch_size: events.length },
    });
  }

  res.json({ received: events.length, suppressed, skipped, unattributed, invite_bounces: inviteBounces });
}

async function reportDroppedBulkEvents(dropped: Map<string, { mismatch: number; unmatched: number; resolved: string | null }>): Promise<boolean> {
  let ok = true;
  for (const [sendId, d] of dropped) {
    const msg = `bulk send ${sendId}: ${d.mismatch} event(s) claimed another workspace, ${d.unmatched} matched no recipient; dropped, nothing suppressed`;
    console.warn(`[sendgrid-events] ${msg}`);
    let first: boolean;
    try {
      const { data, error } = await staffCrossTenantClient("deliverability: alert on bulk bounce/complaint events our send records do not back").rpc(
        "enqueue_ops_alert",
        {
          p_dedupe_key: `sendgrid_bulk_event_dropped:${sendId}`,
          p_source: "sendgrid-events",
          p_code: "bulk_event_dropped",
          p_tenant_id: d.resolved,
          p_msg: msg,
        },
      );
      if (error) throw new Error("enqueue_ops_alert failed");
      first = data === true;
    } catch {
      ok = false;
      continue;
    }
    if (!first) continue;
    const logged = await logEventConfirmed({
      level: "warn",
      source: "sendgrid-events",
      code: "email.suppression.bulk_event_dropped",
      message: msg,
      tenant_id: d.resolved,
      meta: { bulk_send_id: sendId, mismatch: d.mismatch, unmatched: d.unmatched },
    });
    if (!logged.ok) console.warn(`[sendgrid-events] dropped-event log row not written (${logged.error ?? "unknown"}); the ops alert is the record`);
  }
  return ok;
}
