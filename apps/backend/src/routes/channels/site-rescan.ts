
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { getSiteAudit, type SiteReadState } from "@/services/tools/growth/seo/snapshot";
import { resolveTenantSite } from "@/services/tools/growth/seo/run";
import { readStrategyNote } from "@/services/growth/strategy-note";
import { fanOutFirstRun } from "@/services/growth/auto-first-run";
import { projectStrategy } from "@/routes/workspace/growth-strategy";

export const SITE_RESCAN_COOLDOWN_MS = 60_000;
export const SITE_RESCAN_MAX_PER_WINDOW = 5;
export const SITE_RESCAN_WINDOW_MS = 10 * 60_000;

type RescanRecord = { host: string; at: number; hits: number[] };
const rescans = new Map<string, RescanRecord>();

export function resetSiteRescanCooldowns(): void {
  rescans.clear();
}

function hostOf(site: string | null): string {
  if (!site) return "";
  try {
    return new URL(site).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return site.toLowerCase();
  }
}

function claimRescan(tenant_id: string, site: string | null, now: number): number {
  for (const [key, r] of rescans) {
    if (now - r.at >= SITE_RESCAN_WINDOW_MS) rescans.delete(key);
  }
  const host = hostOf(site);
  const rec = rescans.get(tenant_id);
  const hits = (rec?.hits ?? []).filter((t) => now - t < SITE_RESCAN_WINDOW_MS);
  if (hits.length >= SITE_RESCAN_MAX_PER_WINDOW)
    return Math.ceil((SITE_RESCAN_WINDOW_MS - (now - hits[0]!)) / 1000);
  if (rec && rec.host === host && now - rec.at < SITE_RESCAN_COOLDOWN_MS)
    return Math.ceil((SITE_RESCAN_COOLDOWN_MS - (now - rec.at)) / 1000);
  rescans.set(tenant_id, { host, at: now, hits: [...hits, now] });
  return 0;
}

type FirstRun = { ran: boolean; reason?: string; channel_slug?: string };

async function acceptedBets(tenant_id: string) {
  try {
    const note = await readStrategyNote(tenant_id);
    if (!note || note.metadata.accepted !== true) return null;
    return projectStrategy(note.metadata.strategy ?? null)?.channel_bets ?? null;
  } catch {
    return null;
  }
}

export async function siteRescan(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const tenant_id = auth.tenant_id;

  const site = await resolveTenantSite(tenant_id).catch(() => null);
  const retry_after_s = claimRescan(tenant_id, site, Date.now());
  if (retry_after_s > 0) {
    res.status(429).json({
      error: {
        code: "rescan_cooldown",
        message: `We just checked your site. Try again in ${retry_after_s} seconds.`,
        retry_after_s,
      },
    });
    return;
  }

  const audit = await getSiteAudit(tenant_id, { maxAgeMs: 0 });
  const readable =
    audit?.status === "ok" && !audit.error_code && (audit.seo?.pages_analyzed ?? 0) > 0;
  const site_read: SiteReadState = readable
    ? { state: "ok", site: audit!.site, error_code: null }
    : audit
      ? { state: "error", site: audit.site, error_code: audit.error_code }
      : { state: "unknown", site: null, error_code: null };

  let first_run: FirstRun = { ran: false, reason: "site_not_read" };
  if (readable) {
    const bets = await acceptedBets(tenant_id);
    first_run = bets
      ? await fanOutFirstRun(tenant_id, bets)
      : { ran: false, reason: "no_strategy" };
  }

  res.status(200).json({ site_read, first_run });
}
