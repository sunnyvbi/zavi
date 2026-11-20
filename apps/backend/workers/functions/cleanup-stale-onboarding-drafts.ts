
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { purgeExpiredScans } from "@/services/onboarding/scan-store";

export const cleanupStaleOnboardingDraftsFn = inngest.createFunction(
  { id: "cleanup-stale-onboarding-drafts" },
  { cron: "0 10 * * *" },
  async ({ logger }) => {
    const sb = serviceClient();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const { data: activatedUsers, error: actErr } = await sb
      .from("tenant_users")
      .select("user_id");
    if (actErr) {
      logger.warn(`tenant_users read failed: ${actErr.message}`);
    }
    const activatedIds = ((activatedUsers ?? []) as Array<{ user_id: string }>)
      .map((r) => r.user_id)
      .filter(Boolean);

    let removedActivated = 0;
    if (activatedIds.length > 0) {
      const { error, count } = await sb
        .from("onboarding_draft")
        .delete({ count: "exact" })
        .in("user_id", activatedIds);
      if (error) {
        logger.warn(`delete activated drafts failed: ${error.message}`);
      } else {
        removedActivated = count ?? 0;
      }
    }

    const { error: staleErr, count: staleCount } = await sb
      .from("onboarding_draft")
      .delete({ count: "exact" })
      .lt("updated_at", thirtyDaysAgo);
    if (staleErr) {
      logger.warn(`delete stale drafts failed: ${staleErr.message}`);
    }

    let removedScans = 0;
    try {
      removedScans = await purgeExpiredScans();
    } catch (e) {
      logger.warn(`purge expired onboarding scans failed: ${(e as Error).message}`);
    }

    const total = removedActivated + (staleCount ?? 0);
    logger.info(
      `cleanup_stale_onboarding_drafts: removed ${removedActivated} activated + ${
        staleCount ?? 0
      } stale = ${total} rows; ${removedScans} expired onboarding scans`,
    );
    return { removed_activated: removedActivated, removed_stale: staleCount ?? 0, removed_scans: removedScans };
  },
);
