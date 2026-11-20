
import { includesForTier } from "@zavi/shared";
import { isPaidTier, TIER_DISPLAY_NAME, type PaidTier } from "@/services/billing/tiers";
import { resolveTenantOwnerEmailOrThrow, sgSend } from "@/email/sendAuthEmail";
import { renderCompEndingEmail, type CompEmailKind } from "@/email/templates/comp-ending";
import { sendOnce as defaultSendOnce } from "@/email/send-once";
import { billingUrl } from "@/services/web-base";
import { globalClient } from "@/services/tenant-client";
import { freeDailyCreditsFromBlob, FREE_DAILY_CREDITS_SQL_FALLBACK } from "@/services/agents/credits";

const DAY_MS = 86_400_000;

export const COMP_WARNING_WINDOW_MS = 7 * DAY_MS;

export type EndingComp = { tenant_id: string; tier: string | null; comp_expires_at: string };

export function compEmailKind(expiresAt: Date, now: Date): CompEmailKind | null {
  const left = expiresAt.getTime() - now.getTime();
  if (!(left > 0) || left > COMP_WARNING_WINDOW_MS) return null;
  return left <= DAY_MS ? "day" : "week";
}

export function compEndingEmailKey(kind: CompEmailKind, tenantId: string, compExpiresAt: string): string {
  return `comp_ending:${kind}:${tenantId}:${compExpiresAt}`;
}

async function readFreeDailyCredits(): Promise<number> {
  const { data, error } = await globalClient().from("system_config").select("blob").eq("id", 1).maybeSingle();
  if (error) throw new Error(`system_config read failed: ${error.message}`);
  const blob = (data as { blob?: { free_daily_credits?: unknown } | null } | null)?.blob;
  return freeDailyCreditsFromBlob(blob) ?? FREE_DAILY_CREDITS_SQL_FALLBACK;
}

export function compEndingEmailsEnabledFromBlob(blob: unknown): boolean {
  return !!blob && typeof blob === "object" && (blob as { comp_ending_emails_enabled?: unknown }).comp_ending_emails_enabled === true;
}

async function readCompEndingEmailsEnabled(): Promise<boolean> {
  const { data, error } = await globalClient().from("system_config").select("blob").eq("id", 1).maybeSingle();
  if (error) return false;
  return compEndingEmailsEnabledFromBlob((data as { blob?: unknown } | null)?.blob);
}

export type CompEndingDeps = {
  enabled: () => Promise<boolean>;
  sendOnce: typeof defaultSendOnce;
  stillEnding: (comp: EndingComp) => Promise<boolean>;
  ownerEmail: (tenantId: string) => Promise<string | null>;
  send: (to: string, subject: string, html: string, text: string) => Promise<void>;
  freeDailyCredits: () => Promise<number>;
  warn: (msg: string) => void;
  now: () => Date;
};

export async function sendCompEndingEmails(
  comps: readonly EndingComp[],
  over: Partial<CompEndingDeps> & Pick<CompEndingDeps, "stillEnding">,
): Promise<{ sent: number; skipped: number; failed: number }> {
  const deps: CompEndingDeps = {
    enabled: readCompEndingEmailsEnabled,
    sendOnce: defaultSendOnce,
    ownerEmail: resolveTenantOwnerEmailOrThrow,
    send: (to, subject, html, text) => sgSend(to, subject, html, text),
    freeDailyCredits: readFreeDailyCredits,
    warn: (msg) => console.warn(msg),
    now: () => new Date(),
    ...over,
  };
  const out = { sent: 0, skipped: 0, failed: 0 };
  if (comps.length === 0) return out;
  if (!(await deps.enabled())) {
    out.skipped = comps.length;
    return out;
  }
  const now = deps.now();
  let daily: number | null = null;
  for (const c of comps) {
    const endsAt = new Date(c.comp_expires_at);
    const kind = compEmailKind(endsAt, now);
    if (!kind || !isPaidTier(c.tier)) {
      out.skipped++;
      continue;
    }
    try {
      if (!(await deps.stillEnding(c))) {
        out.skipped++;
        continue;
      }
      const to = await deps.ownerEmail(c.tenant_id);
      if (!to) {
        out.skipped++;
        continue;
      }
      daily ??= await deps.freeDailyCredits();
      const mail = renderCompEndingEmail({
        kind,
        tierName: TIER_DISPLAY_NAME[c.tier as PaidTier],
        endsAt,
        now,
        freeIncludes: includesForTier("free"),
        freeDailyCredits: daily,
        billingUrl: billingUrl(c.tenant_id),
      });
      const r = await deps.sendOnce(compEndingEmailKey(kind, c.tenant_id, c.comp_expires_at), () =>
        deps.send(to, mail.subject, mail.html, mail.text),
      );
      if (r === "sent") out.sent++;
      else out.skipped++;
    } catch (e) {
      out.failed++;
      deps.warn(`comp-ending email failed for ${c.tenant_id}: ${(e as Error).message}`);
    }
  }
  return out;
}
