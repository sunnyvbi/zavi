
import { inngest } from "../client";
import { reapSites, type SiteReaperResult } from "@/services/sites/site-reaper";
import { alert } from "@/services/logging/alert";
import { enqueueSitePointerRepairs, realEnqueueDeps } from "./site-reconcile";

export function siteReaperAlert(r: SiteReaperResult): { msg: string; code: string } | null {
  if (r.refused || r.dry_run) return null;
  const errors = r.skipped.filter((s) => s.reason.startsWith("error:")).length;
  const refusedLive = r.skipped.filter((s) => s.reason === "has_live_deploy").length;
  if (r.reaped.length + r.pending.length + errors + refusedLive === 0) return null;
  return {
    code: errors + refusedLive > 0 ? "site_reaper_errors" : "site_reaper_teardown",
    msg: `site-reaper: scanned=${r.scanned} reaped=${r.reaped.length} pending=${r.pending.length} errors=${errors} refused_live=${refusedLive}`,
  };
}

export const siteReaperFn = inngest.createFunction(
  { id: "site-reaper", concurrency: { limit: 1, key: '"global"' } },
  { cron: "17 * * * *" },
  async ({ logger }) => {
    let reap: SiteReaperResult | { error: string };
    try {
      const r = await reapSites();
      reap = r;
      if (r.refused) logger.warn(`site-reaper: skipped — ${r.refused}`);
      else logger.info(`site-reaper: scanned=${r.scanned} reaped=${r.reaped.length} pending=${r.pending.length} skipped=${r.skipped.length} dry_run=${r.dry_run}`);
      const a = siteReaperAlert(r);
      if (a) await alert({ msg: a.msg, code: a.code, source: "site-reaper" }).catch(() => undefined);
    } catch (e) {
      reap = { error: String((e as Error)?.message ?? e).slice(0, 300) };
      logger.error(`site-reaper: failed — ${reap.error}`);
      await alert({ msg: `site-reaper: pass failed: ${reap.error}`, code: "site_reaper_failed", source: "site-reaper" }).catch(() => undefined);
    }
    let pointer: { enqueued: number; skipped?: string } | { error: string };
    try {
      pointer = await enqueueSitePointerRepairs(realEnqueueDeps());
      if (pointer.enqueued) logger.warn(JSON.stringify({ evt: "site_pointer", level: "warn", msg: "drifted sites queued for repair", count: pointer.enqueued }));
    } catch (e) {
      pointer = { error: String((e as Error)?.message ?? e).slice(0, 300) };
      logger.error(`site-reaper: pointer drift sweep failed — ${pointer.error}`);
    }
    if ("error" in reap) throw new Error(`site-reaper: ${reap.error}`);
    return { ok: true, ...reap, pointer };
  },
);
