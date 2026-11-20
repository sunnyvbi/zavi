
import type { SiteDeployDeps } from "@/services/agents/conductor";
import type { SiteDeployHandler, SiteStore } from "./contract";
import { siteStore } from "./store";
import { parseJourneyFixClaim, siteDesignStore } from "./site-design-store";
import { asTenantId, tenantRpc } from "@/services/tenant-client";
import { siteWiring } from "./wiring";
import { readProvisionedRepoHead } from "@/services/provisioning/github-repo";
import { resolveProvisionOrg } from "@/services/provisioning/provision-org";
import { getNumberSetting } from "@/services/settings";
import { runWithNodeCheckpoints } from "./deploy-checkpoints";
import { isSiteDatabaseCapacityError } from "@/services/site-shards/contract";

export type SiteDeployDepsInput = {
  store?: SiteStore;
  handler?: () => SiteDeployHandler | null;
  headOf?: (github_full_name: string) => Promise<{ sha: string } | { error: string }>;
  requestCapacitySweep?: () => Promise<void>;
  org?: () => string;
  repairAttempts?: (tenant_id: string) => Promise<number>;
  logEditTiming?: (input: { tenant_id: string; site_id: string; conductor_run_id: string; refine_requested_at: string }) => Promise<void>;
};

export const SITE_PUBLISH_UNAVAILABLE = "Publishing new-stack sites is not available yet.";

const CAPACITY_SWEEP_GAP_MS = 60_000;
let lastCapacitySweepAt = 0;

async function defaultCapacitySweep(): Promise<void> {
  if (Date.now() - lastCapacitySweepAt < CAPACITY_SWEEP_GAP_MS) return;
  lastCapacitySweepAt = Date.now();
  const { isCanonicalContainer } = await import("@/services/agents/boot-role");
  if (process.env.NODE_ENV !== "production" || !isCanonicalContainer()) return;
  const [{ requestShardMetricsSweep }, { shardEnv }] = await Promise.all([
    import("@/../workers/functions/site-shards-metrics"),
    import("@/services/site-shards/registry"),
  ]);
  await requestShardMetricsSweep({ env: shardEnv(), reason: "publish_waiting" });
}

export function makeSiteDeployDeps(input: SiteDeployDepsInput = {}): SiteDeployDeps {
  const store = () => input.store ?? siteStore();
  const requestSweep = input.requestCapacitySweep ?? defaultCapacitySweep;
  const handler = input.handler ?? (() => siteWiring().deployHandler);
  const headOf = input.headOf ?? ((full: string) => readProvisionedRepoHead(full, "main"));
  const org = input.org ?? (() => resolveProvisionOrg());
  const repairAttempts = input.repairAttempts ?? ((t: string) => getNumberSetting("fast_build_repair_attempts", t));
  const logEditTiming =
    input.logEditTiming ?? (async (i: Parameters<NonNullable<SiteDeployDepsInput["logEditTiming"]>>[0]) => (await import("./site-timing")).logSiteEditTiming(i));
  return {
    async step({ checkpoint, ...i }) {
      const h = handler();
      if (!h) return { kind: "failed", reason: SITE_PUBLISH_UNAVAILABLE };
      try {
        return await runWithNodeCheckpoints(checkpoint, () => h.step(i));
      } catch (e) {
        if (!isSiteDatabaseCapacityError(e)) throw e;
        console.warn(`[site-deploy] site ${i.site_id}: no site database capacity yet (${String((e as Error)?.message ?? e).slice(0, 200)})`);
        await requestSweep().catch((err: unknown) => {
          console.warn(`[site-deploy] metrics sweep request failed: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
        });
        return { kind: "waiting", reason: "database_capacity" };
      }
    },
    async headSha({ tenant_id, site_id }) {
      const site = await store().get(tenant_id, site_id);
      if (!site?.github_full_name) return null;
      const head = await headOf(site.github_full_name);
      if ("error" in head) throw new Error(head.error);
      return head.sha;
    },
    async ownsSite({ tenant_id, site_id }) {
      const site = await store().get(tenant_id, site_id);
      const owner = (site?.github_full_name ?? "").split("/")[0]?.trim().toLowerCase();
      if (!owner) return true;
      return owner === org().trim().toLowerCase();
    },
    async markDesired({ tenant_id, site_id }) {
      const row = await store().transition(tenant_id, site_id, ["building"], "publishing");
      return typeof row?.publish_generation === "number" ? { publish_generation: row.publish_generation } : {};
    },
    async settle({ tenant_id, site_id, outcome, reason, conductor_run_id, refine_requested_at, refine_run, generation }) {
      if (outcome === "live") {
        await store().transition(tenant_id, site_id, ["building", "publishing", "live"], "live", { last_error: null });
        if (conductor_run_id && refine_requested_at) {
          await logEditTiming({ tenant_id, site_id, conductor_run_id, refine_requested_at }).catch(() => undefined);
        }
        return;
      }
      if (outcome === "paused") {
        await store().settleStopped(tenant_id, site_id, "building", (reason ?? "publish stopped").slice(0, 500), generation, conductor_run_id);
      } else {
        const last_error = (reason ?? "publish failed").slice(0, 500);
        await store().settleStopped(tenant_id, site_id, refine_run === true ? "building" : "failed", last_error, generation, conductor_run_id);
      }
    },
    repairMaxAttempts: repairAttempts,
    claimJourneyFix: ({ tenant_id, site_id, conductor_run_id, attempt }) =>
      siteDesignStore().claimJourneyFix(tenant_id, site_id, conductor_run_id, attempt),
    releaseJourneyFix: ({ tenant_id, site_id, token }) => siteDesignStore().releaseJourneyFix(tenant_id, site_id, token),
    async claimVisionFix({ tenant_id, site_id, conductor_run_id, attempt }) {
      const { data, error } = await tenantRpc(asTenantId(tenant_id), "claim_site_vision_fix_status", {
        p_site_id: site_id,
        p_conductor_run_id: conductor_run_id,
        p_attempt: attempt,
      });
      if (error) throw new Error(`site vision fix claim failed: ${error.message}`);
      return parseJourneyFixClaim(data);
    },
    async releaseVisionFix({ tenant_id, site_id, conductor_run_id, token }) {
      const { error } = await tenantRpc(asTenantId(tenant_id), "release_site_vision_fix", {
        p_site_id: site_id,
        p_conductor_run_id: conductor_run_id,
        p_token: token,
      });
      if (error) throw new Error(`site vision fix release failed: ${error.message}`);
    },
    async neverPublished({ tenant_id, site_id }) {
      const site = await store().get(tenant_id, site_id);
      return !!site && !site.live_deploy_id;
    },
  };
}
