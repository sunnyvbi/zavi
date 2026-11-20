import { inngest } from "../client";
import { buildSubmissionPreviews } from "@/services/creators/submission-preview";

export const CREATOR_SUBMISSION_PREVIEW_TENANT_C8reverified = true;

export const creatorSubmissionPreviewFn = inngest.createFunction(
  {
    id: "creator-submission-preview",
    retries: 2,
    concurrency: [
      { key: "event.data.order_id", limit: 1 },
      { key: "event.data.tenant_id", limit: 2 },
    ],
  },
  { event: "creator/submission.preview.requested" },
  async ({ event, step }) => {
    const { order_id, version } = event.data as { order_id: string; version: number };
    return step.run("watermark", async () => {
      const result = await buildSubmissionPreviews({ order_id, version });
      if (result.failed.length > 0) {
        throw new Error(`watermark preview failed for ${result.failed.length} file(s): ${result.failed.map((f) => f.code).join(", ")}`);
      }
      return result;
    });
  },
);
