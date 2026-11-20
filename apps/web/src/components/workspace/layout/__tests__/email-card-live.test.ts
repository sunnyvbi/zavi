import { describe, expect, it } from "vitest";
import { chatStagedItemsOf, priorItemsOf } from "../ChannelsPanel";

type Row = { id: string; action_source: "decision" | "channel_action"; thread_id: string | null; decision_class: string };
const row = (id: string, over: Partial<Omit<Row, "id">> = {}): Row => ({ id, action_source: "decision", thread_id: null, decision_class: "growth.task.v1", ...over });

describe("an email send waiting for approval on the channel page", () => {
  it("is drawn live, never filed read-only under Older suggestions, even when a channel run proposed it", () => {
    const bulk = row("bulk", { decision_class: "bulk_outbound.send" });
    const tool = row("tool", { decision_class: "email_campaign.create_and_send" });
    const stale = row("stale");
    const items = [bulk, tool, stale];
    expect(chatStagedItemsOf(items).map((d) => d.id)).toEqual(["bulk", "tool"]);
    expect(priorItemsOf(items).map((d) => d.id)).toEqual(["stale"]);
  });
});
