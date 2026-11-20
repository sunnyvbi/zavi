
import { inngest } from "../client";
import { generateCreatorIllustration } from "@/services/creators/creator-illustration";

export const creatorIllustrationFn = inngest.createFunction(
  {
    id: "creator-illustration",
    idempotency: "event.data.human_member_id",
    retries: 0,
    concurrency: { limit: 5 },
  },
  { event: "creator/illustration.generate" },
  async ({ event, step }) => {
    const { human_member_id } = event.data as { human_member_id: string };
    return step.run("generate", () => generateCreatorIllustration(human_member_id));
  },
);
