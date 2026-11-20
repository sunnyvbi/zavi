
import { inngest } from "../client";

export const pingFn = inngest.createFunction(
  { id: "ping", retries: 0 },
  { event: "ping" },
  async ({ event, step }) => {
    await step.sendEvent("pong", {
      name: "pong",
      data: {
        correlation_id: (event.data as { correlation_id?: string })?.correlation_id ?? "",
        ts: new Date().toISOString(),
      },
    });
    return { ok: true };
  },
);
