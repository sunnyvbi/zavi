
import { alert as opsAlert, type AlertInput } from "@/services/logging/alert";
import { tickAttemptBucket } from "@/services/launch-video-public/store";

export const DEFAULT_SITE_DELETE_MAX_PER_HOUR = 5;
export const SITE_DELETE_WINDOW_SECONDS = 60 * 60;
export const SITE_DELETE_BUCKET = {
  schedule: "site_delete:schedule",
  execute: "site_delete:execute",
} as const;

export type SiteDeletePhase = keyof typeof SITE_DELETE_BUCKET;

export type SiteDeleteGuard = {
  tick: (key: string, limit: number, windowSeconds: number) => Promise<boolean>;
  maxPerHour: number;
  alert: (input: AlertInput) => Promise<void>;
  error: (msg: string) => void;
};

export function siteDeleteMaxPerHour(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.SITE_DELETE_MAX_PER_HOUR);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_SITE_DELETE_MAX_PER_HOUR;
}

export function defaultSiteDeleteGuard(): SiteDeleteGuard {
  return {
    tick: (key, limit, windowSeconds) => tickAttemptBucket(key, limit, windowSeconds),
    maxPerHour: siteDeleteMaxPerHour(),
    alert: (input) => opsAlert(input),
    error: (m) => console.error(m),
  };
}

export async function reportDeleteRefusal(
  guard: SiteDeleteGuard,
  code: "sites.delete.circuit_open" | "sites.delete.name_mismatch",
  ctx: { tenant_id: string; site_id: string; detail: string },
): Promise<void> {
  const msg = `${code} tenant=${ctx.tenant_id} site=${ctx.site_id} ${ctx.detail}`;
  try {
    guard.error(`[sites] ${msg}`);
  } catch {
  }
  try {
    await guard.alert({ msg, source: "site-delete-guard", code, tenant_id: ctx.tenant_id });
  } catch {
  }
}

export async function takeDeleteSlot(
  guard: SiteDeleteGuard,
  phase: SiteDeletePhase,
  ctx: { tenant_id: string; site_id: string },
): Promise<boolean> {
  let allowed = false;
  let detail = `phase=${phase} limit=${guard.maxPerHour}/h`;
  try {
    allowed = (await guard.tick(SITE_DELETE_BUCKET[phase], guard.maxPerHour, SITE_DELETE_WINDOW_SECONDS)) === true;
  } catch (e) {
    allowed = false;
    detail += ` counter_unavailable: ${String((e as Error)?.message ?? e).slice(0, 120)}`;
  }
  if (!allowed) await reportDeleteRefusal(guard, "sites.delete.circuit_open", { ...ctx, detail });
  return allowed;
}
