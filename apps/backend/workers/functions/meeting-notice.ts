
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { deliverNotetakerNotice, type NoticeKind } from "@/services/meetings/notices";

export const meetingNoticeFn = inngest.createFunction(
  {
    id: "meeting-notice",
    retries: 4,
    concurrency: [{ scope: "fn", key: "event.data.tenant_id", limit: 1 }],
  },
  { event: "meeting.notice" },
  async ({ event, step }) => {
    const meetingBotId = String(event.data.meeting_bot_id ?? "");
    if (!meetingBotId) return { skipped: "no_bot_id" };
    const kind: NoticeKind = event.data.kind === "waiting" ? "waiting" : "no_record";
    return step.run("deliver", () => deliverNotetakerNotice(meetingBotId, kind, serviceClient()));
  },
);
