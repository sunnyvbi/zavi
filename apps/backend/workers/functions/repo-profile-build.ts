
import { inngest } from "../client";
import { buildTenantRepoProfiles } from "@/services/sandbox/repo-profiles";

export const REPO_PROFILE_BUILD_TENANT_C8reverified = true;

export const repoProfileBuildFn = inngest.createFunction(
  { id: "repo-profile-build", concurrency: 4, retries: 1 },
  { event: "repo.profile.build.requested" },
  async ({ event, logger }) => {
    const tenant_id = event.data.tenant_id;
    const only_repos = event.data.only_repos;
    if (!tenant_id || typeof tenant_id !== "string") {
      logger.warn("repo-profile-build: missing tenant_id in event");
      return { outcome: "no_tenant" };
    }

    const result = await buildTenantRepoProfiles({ tenant_id, only_repos });
    const ready = Object.values(result).filter((s) => s === "ready").length;
    const errored = Object.values(result).filter((s) => s === "error").length;
    logger.info(
      `repo-profile-build: tenant=${tenant_id} ready=${ready} error=${errored} repos=${Object.keys(result).length}`,
    );
    return { outcome: "built", ready, errored, repos: Object.keys(result).length };
  },
);
