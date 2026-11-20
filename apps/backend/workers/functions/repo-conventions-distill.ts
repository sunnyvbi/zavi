
import { inngest } from "../client";
import { distillRepoConventionsFromMergedPr } from "@/services/sandbox/repo-conventions";

export const REPO_CONVENTIONS_DISTILL_TENANT_C8reverified = true;

export const repoConventionsDistillFn = inngest.createFunction(
  { id: "repo-conventions-distill", concurrency: 4, retries: 1 },
  { event: "repo.conventions.distill.requested" },
  async ({ event, logger }) => {
    const tenant_id = event.data.tenant_id as string | undefined;
    const repo_full_name = event.data.repo_full_name as string | undefined;
    const pull_number = event.data.pull_number as number | undefined;
    const pr_url = event.data.pr_url as string | undefined;
    if (
      !tenant_id ||
      !repo_full_name ||
      typeof pull_number !== "number" ||
      !pr_url
    ) {
      logger.warn("repo-conventions-distill: missing required event fields");
      return { outcome: "bad_event" };
    }

    const result = await distillRepoConventionsFromMergedPr({
      tenant_id,
      repo_full_name,
      pull_number,
      pr_url,
    });
    logger.info(
      `repo-conventions-distill: tenant=${tenant_id} repo=${repo_full_name} pr=${pr_url} written=${result.written} skipped=${result.skipped}`,
    );
    return { outcome: "distilled", ...result };
  },
);
