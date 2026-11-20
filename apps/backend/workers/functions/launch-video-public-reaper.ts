
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { logEvent } from "@/services/logging/logEvent";
import {
  LAUNCH_VIDEO_PUBLIC_RETENTION_DAYS,
  LAUNCH_VIDEO_PUBLIC_REAP_BATCH_SIZE,
  isLaunchVideoPublicJobReapEligible,
  isLaunchVideoShellTenantReapEligible,
  retentionCutoffIso,
} from "./cleanup-gc-boundaries";

const BUCKET = "launch-video-artifacts";
const SHELL_KIND = "launch_video_shell";

type JobRow = {
  id: string;
  tenant_id: string;
  status: string | null;
  claimed_by_user_id: string | null;
  claimed_at: string | null;
  created_at: string;
};

async function removeJobObjects(
  sb: ReturnType<typeof serviceClient>,
  tenantId: string,
  jobId: string,
  logger: { warn: (m: string) => void },
): Promise<number> {
  const prefix = `${tenantId}/${jobId}`;
  const { data: entries, error: listErr } = await sb.storage.from(BUCKET).list(prefix, { limit: 100 });
  if (listErr) {
    logger.warn(`launch-video-public-reaper: list failed for ${prefix}: ${listErr.message}`);
    return 0;
  }
  const names = (entries ?? [])
    .map((e: { name: string | null }) => e.name)
    .filter((n): n is string => typeof n === "string" && n.length > 0)
    .map((n) => `${prefix}/${n}`);
  if (names.length === 0) return 0;
  const { error: rmErr } = await sb.storage.from(BUCKET).remove(names);
  if (rmErr) {
    logger.warn(`launch-video-public-reaper: remove failed for ${prefix}: ${rmErr.message}`);
    return 0;
  }
  return names.length;
}

export const launchVideoPublicReaperFn = inngest.createFunction(
  { id: "launch-video-public-reaper", concurrency: 1 },
  { cron: "30 4 * * *" },
  async ({ logger }) => {
    const sb = serviceClient();
    const cutoff = retentionCutoffIso(LAUNCH_VIDEO_PUBLIC_RETENTION_DAYS);

    const { data: jobRows, error: jobErr } = await sb
      .from("launch_video_public_jobs")
      .select("id, tenant_id, status, claimed_by_user_id, claimed_at, created_at")
      .lt("created_at", cutoff)
      .neq("status", "claimed")
      .limit(LAUNCH_VIDEO_PUBLIC_REAP_BATCH_SIZE);
    if (jobErr) throw new Error(`launch_video job scan failed: ${jobErr.message}`);
    const candidates = (jobRows ?? []) as JobRow[];

    const tenantIds = [...new Set(candidates.map((j) => j.tenant_id))];
    const kindByTenant = new Map<string, string | null>();
    if (tenantIds.length > 0) {
      const { data: tRows, error: tErr } = await sb.from("tenants").select("id, kind").in("id", tenantIds);
      if (tErr) throw new Error(`tenant kind read failed: ${tErr.message}`);
      for (const t of (tRows ?? []) as Array<{ id: string; kind: string | null }>) {
        kindByTenant.set(t.id, t.kind);
      }
    }

    const eligible = candidates.filter((j) =>
      isLaunchVideoPublicJobReapEligible(
        {
          created_at: j.created_at,
          status: j.status,
          claimed_by_user_id: j.claimed_by_user_id,
          claimed_at: j.claimed_at,
          tenant_kind: kindByTenant.get(j.tenant_id) ?? null,
        },
        cutoff,
      ),
    );
    const protectedCount = candidates.length - eligible.length;

    let objectsRemoved = 0;
    let jobsRemoved = 0;
    let errors = 0;
    for (const job of eligible) {
      try {
        objectsRemoved += await removeJobObjects(sb, job.tenant_id, job.id, logger);
        const { error: artErr } = await sb
          .from("run_artifacts")
          .delete()
          .eq("tenant_id", job.tenant_id)
          .eq("run_id", job.id);
        if (artErr) throw new Error(`run_artifacts delete failed: ${artErr.message}`);

        const { error: delErr } = await sb.from("launch_video_public_jobs").delete().eq("id", job.id);
        if (delErr) throw new Error(`job delete failed: ${delErr.message}`);
        jobsRemoved += 1;
      } catch (e) {
        errors += 1;
        logger.warn(`launch-video-public-reaper: job ${job.id} reap failed: ${(e as Error).message}`);
      }
    }

    const { data: shellRows, error: shellErr } = await sb
      .from("tenants")
      .select("id, kind, created_at")
      .eq("kind", SHELL_KIND)
      .lt("created_at", cutoff)
      .limit(LAUNCH_VIDEO_PUBLIC_REAP_BATCH_SIZE);
    if (shellErr) throw new Error(`shell tenant scan failed: ${shellErr.message}`);

    let tenantsRemoved = 0;
    for (const shell of (shellRows ?? []) as Array<{ id: string; kind: string | null; created_at: string | null }>) {
      try {
        const [{ count: jobCount, error: jcErr }, { count: memberCount, error: mcErr }] = await Promise.all([
          sb
            .from("launch_video_public_jobs")
            .select("id", { count: "exact", head: true })
            .eq("tenant_id", shell.id),
          sb.from("tenant_users").select("user_id", { count: "exact", head: true }).eq("tenant_id", shell.id),
        ]);
        if (jcErr) throw new Error(`job count failed: ${jcErr.message}`);
        if (mcErr) throw new Error(`member count failed: ${mcErr.message}`);

        const ok = isLaunchVideoShellTenantReapEligible(
          {
            created_at: shell.created_at,
            kind: shell.kind,
            job_count: jobCount ?? 0,
            member_count: memberCount ?? 0,
          },
          cutoff,
        );
        if (!ok) continue;

        const { error: tdErr } = await sb.from("tenants").delete().eq("id", shell.id).eq("kind", SHELL_KIND);
        if (tdErr) throw new Error(`tenant delete failed: ${tdErr.message}`);
        tenantsRemoved += 1;
      } catch (e) {
        errors += 1;
        logger.warn(`launch-video-public-reaper: shell ${shell.id} reap failed: ${(e as Error).message}`);
      }
    }

    logger.info(
      `launch-video-public-reaper: removed ${jobsRemoved} job row(s), ${objectsRemoved} object(s), ` +
        `${tenantsRemoved} shell tenant(s); protected ${protectedCount} candidate(s) (cutoff=${cutoff})`,
    );

    await logEvent({
      level: errors > 0 ? "warn" : "info",
      source: "launch-video-public-reaper",
      code: "deleted",
      meta: { removed: jobsRemoved, total: candidates.length, batch_errors: errors },
    });

    return {
      jobs_removed: jobsRemoved,
      objects_removed: objectsRemoved,
      tenants_removed: tenantsRemoved,
      protected: protectedCount,
      errors,
    };
  },
);
