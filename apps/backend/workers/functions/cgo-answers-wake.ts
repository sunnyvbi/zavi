
import { inngest } from "../client";
import { ANSWER_WAKE_PERIOD, ANSWER_WAKE_TIMEOUT, wakeCgoForRecentAnswers } from "@/services/growth/cgo-answers";

export const cgoAnswersWakeFn = inngest.createFunction(
  {
    id: "cgo-answers-wake",
    retries: 2,
    debounce: { key: "event.data.tenant_id", period: ANSWER_WAKE_PERIOD, timeout: ANSWER_WAKE_TIMEOUT },
  },
  { event: "cgo/answers.answered" },
  async ({ event, step }) => step.run("wake", () => wakeCgoForRecentAnswers(event.data)),
);
