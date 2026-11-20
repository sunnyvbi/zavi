
import { serviceClient } from "@/services/supabase";
import { utcDay } from "@/services/agents/budget";
import { publicApiBaseUrl } from "@/services/api-base";

export function safetyNetEnabled(): boolean {
  return process.env.PRAXIS_COMMS_SAFETY_NET !== "0";
}

export function resolveEnvDailySendCap(): number {
  const raw = process.env.PRAXIS_DAILY_EMAIL_CAP;
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export const WARMUP_GRADUATED_DAY = 10;
const WARMUP_BASE = 50;

export function warmupAllowance(dayIndex: number): number {
  if (!Number.isFinite(dayIndex) || dayIndex < 0) return WARMUP_BASE;
  if (dayIndex >= WARMUP_GRADUATED_DAY) return 0;
  return WARMUP_BASE * 2 ** dayIndex;
}

export function effectiveCap(dailyCap: number, warmup: number): number {
  const limits = [dailyCap, warmup].filter((n) => n > 0);
  if (limits.length === 0) return 0;
  return Math.min(...limits);
}

export function sendingDomain(fromAddress: string): string | null {
  const at = fromAddress.lastIndexOf("@");
  if (at < 0 || at === fromAddress.length - 1) return null;
  return fromAddress.slice(at + 1).trim().toLowerCase() || null;
}

export async function isSuppressed(
  tenantId: string,
  email: string,
): Promise<string | null> {
  const { data, error } = await serviceClient().rpc("is_email_suppressed", {
    p_tenant_id: tenantId,
    p_email: email,
  });
  if (error) {
    throw new Error(`is_email_suppressed failed: ${error.message}`);
  }
  return (data as string | null) ?? null;
}

export async function suppressEmail(
  tenantId: string,
  email: string,
  reason: "unsubscribe" | "bounce" | "complaint" | "manual" = "unsubscribe",
): Promise<string> {
  const { data, error } = await serviceClient().rpc("suppress_email", {
    p_tenant_id: tenantId,
    p_email: email,
    p_reason: reason,
  });
  if (error) {
    throw new Error(`suppress_email failed: ${error.message}`);
  }
  return data as string;
}

export async function unsubscribeAndCount(tenantId: string, email: string): Promise<void> {
  const { asTenantId, tenantRpc } = await import("@/services/tenant-client");
  const { error } = await tenantRpc(asTenantId(tenantId), "email_unsubscribe_and_count", { p_email: email });
  if (error) {
    throw new Error(`email_unsubscribe_and_count failed: ${error.message}`);
  }
}

export async function getOrCreateUnsubToken(
  tenantId: string,
  email: string,
): Promise<string> {
  const { data, error } = await serviceClient().rpc("get_or_create_unsub_token", {
    p_tenant_id: tenantId,
    p_email: email,
  });
  if (error) {
    throw new Error(`get_or_create_unsub_token failed: ${error.message}`);
  }
  return data as string;
}

export function unsubscribeUrl(token: string): string {
  return `${publicApiBaseUrl()}/api/email/unsubscribe?token=${encodeURIComponent(token)}`;
}

export function unsubscribeHeaders(token: string): {
  "List-Unsubscribe": string;
  "List-Unsubscribe-Post": string;
} {
  return {
    "List-Unsubscribe": `<${unsubscribeUrl(token)}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

async function peekDomainWarmup(
  tenantId: string,
  domain: string,
  day: string,
): Promise<number> {
  const { data, error } = await serviceClient().rpc("peek_domain_warmup", {
    p_tenant_id: tenantId,
    p_domain: domain,
    p_day: day,
  });
  if (error) {
    throw new Error(`peek_domain_warmup failed: ${error.message}`);
  }
  return Number(data ?? 0);
}

export async function recordWarmupSend(tenantId: string, warmup: WarmupMark | null): Promise<void> {
  if (!warmup) return;
  const { error } = await serviceClient().rpc("touch_domain_warmup", {
    p_tenant_id: tenantId,
    p_domain: warmup.domain,
    p_day: warmup.day,
  });
  if (error) console.warn(`[email.safety-net] warmup not recorded for tenant ${tenantId}: ${error.message}`);
}

async function consumeSendOrReject(
  tenantId: string,
  day: string,
  dailyCap: number,
  warmup: number,
): Promise<boolean> {
  const { data, error } = await serviceClient().rpc("consume_email_send_or_reject", {
    p_tenant_id: tenantId,
    p_day: day,
    p_daily_cap: dailyCap,
    p_warmup_cap: warmup,
  });
  if (error) {
    throw new Error(`consume_email_send_or_reject failed: ${error.message}`);
  }
  return data === true;
}

export type WarmupMark = { domain: string; day: string };

export type GuardDecision =
  | { allowed: true; unsubToken: string; warmup: WarmupMark | null }
  | {
      allowed: false;
      code: "recipient_suppressed" | "daily_send_cap_exceeded";
      reason: string;
      meta: { suppression_reason?: string; day_index?: number; effective_cap?: number };
    };

export async function guardOutboundSend(args: {
  tenantId: string;
  to: string;
  fromAddress: string;
  day?: string;
}): Promise<GuardDecision> {
  const day = args.day ?? utcDay();

  const suppression = await isSuppressed(args.tenantId, args.to);
  if (suppression) {
    return {
      allowed: false,
      code: "recipient_suppressed",
      reason: `Recipient ${args.to} is suppressed (${suppression}) for this workspace.`,
      meta: { suppression_reason: suppression },
    };
  }

  const unsubToken = await getOrCreateUnsubToken(args.tenantId, args.to);

  if (!safetyNetEnabled()) {
    return { allowed: true, unsubToken, warmup: null };
  }

  const domain = sendingDomain(args.fromAddress);
  const dayIndex = domain
    ? await peekDomainWarmup(args.tenantId, domain, day)
    : 0;
  const warmup = domain ? warmupAllowance(dayIndex) : 0;
  const dailyCap = resolveEnvDailySendCap();
  const effective = effectiveCap(dailyCap, warmup);

  const charged = await consumeSendOrReject(args.tenantId, day, dailyCap, warmup);
  if (!charged) {
    return {
      allowed: false,
      code: "daily_send_cap_exceeded",
      reason: `Daily outbound email cap reached for this workspace (effective cap ${effective}, domain warmup day ${dayIndex}).`,
      meta: { day_index: dayIndex, effective_cap: effective },
    };
  }

  return { allowed: true, unsubToken, warmup: domain ? { domain, day } : null };
}
