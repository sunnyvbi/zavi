import { describe, expect, it } from "vitest";
import { chatStagedItemsOf, priorItemsOf } from "../ChannelsPanel";

type Row = { id: string; action_source: "decision" | "channel_action"; thread_id: string | null; decision_class: string };
const row = (id: string, over: Partial<Omit<Row, "id">> = {}): Row => ({ id, action_source: "decision", thread_id: null, decision_class: "growth.task.v1", ...over });

describe("a staged post waiting for approval", () => {
  it("is drawn live with Approve, never filed read-only under Older suggestions, even when no chat thread staged it", () => {
    const pin = row("pin", { decision_class: "social.publish.v2" });
    const stale = row("stale");
    const chat = row("chat", { thread_id: "t-1" });
    const lane = row("lane", { action_source: "channel_action", decision_class: "social.publish.v2" });
    const items = [pin, stale, chat, lane];
    expect(chatStagedItemsOf(items).map((d) => d.id)).toEqual(["pin", "chat"]);
    expect(priorItemsOf(items).map((d) => d.id)).toEqual(["stale"]);
  });
});
