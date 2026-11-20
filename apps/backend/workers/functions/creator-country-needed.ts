
import { inngest } from "../client";
import { COUNTRY_REMINDER_DELAY, sendCountryNeededIfMissing } from "@/services/creators/creator-setup";

export const creatorCountryNeededWaitFn = inngest.createFunction(
  { id: "creator-country-needed-wait", concurrency: 20 },
  { event: "creator/setup.country_check" },
  async ({ event, step }) => {
    const { human_member_id } = event.data as { human_member_id: string };
    await step.sleep("a-day-after-live", COUNTRY_REMINDER_DELAY);
    return step.run("send", () => sendCountryNeededIfMissing(human_member_id));
  },
);
