
import { inngest } from "../client";
import { getBoolSetting } from "@/services/settings";
import { pollDeployTruth, realDeployTruthPollDeps } from "@/services/pipeline/deploy-truth";

export const deployTruthPollFn = inngest.createFunction(
  { id: "deploy-truth-poll", concurrency: 1 },
  { cron: "*/10 * * * *" },
  async ({ logger }) => {
    const enabled = await getBoolSetting("deploy_truth_enabled");
    if (!enabled) {
      return { skipped: true, reason: "deploy_truth_disabled" };
    }
    const token = process.env.RENDER_API_KEY ?? null;
    if (!token) {
      return { skipped: true, reason: "no_render_api_key" };
    }
    const result = await pollDeployTruth(realDeployTruthPollDeps(token));
    if (result.checked > 0) {
      logger.info(
        `deploy-truth-poll: checked ${result.checked} — ` +
          `${result.healthy} healthy, ${result.failed} failed, ` +
          `${result.watching} watching, ${result.errored} errored`,
      );
    }
    return result;
  },
);
