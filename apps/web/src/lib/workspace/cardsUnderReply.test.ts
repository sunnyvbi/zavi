import { describe, expect, it } from "vitest";
import { cardsUnderReply, type ChatRow } from "./useChatThread";

const row = (id: string, kind: ChatRow["kind"], at: string, run?: string): ChatRow =>
  ({ id, kind, agent_run_id: run ?? null, body: {}, citations: [], created_at: at }) as ChatRow;

describe("cardsUnderReply", () => {
  it("moves a run's cards under that run's reply (shown mid-run, sorted above it by time)", () => {
    const rows = [
      row("u", "chat_user", "08:00", "r1"),
      row("d1", "decision", "08:02:34", "r1"),
      row("d2", "decision", "08:02:35", "r1"),
      row("a", "chat_assistant", "08:02:57", "r1"),
      row("u2", "chat_user", "08:05", "r2"),
    ];
    expect(cardsUnderReply(rows).map((r) => r.id)).toEqual(["u", "a", "d1", "d2", "u2"]);
  });

  it("keeps cards in time order while their run has no reply yet", () => {
    const rows = [row("u", "chat_user", "08:00", "r1"), row("d1", "decision", "08:02", "r1")];
    expect(cardsUnderReply(rows).map((r) => r.id)).toEqual(["u", "d1"]);
  });

  it("never moves another run's card", () => {
    const rows = [
      row("d0", "decision", "07:00", "r0"),
      row("u", "chat_user", "08:00", "r1"),
      row("a", "chat_assistant", "08:03", "r1"),
    ];
    expect(cardsUnderReply(rows).map((r) => r.id)).toEqual(["d0", "u", "a"]);
  });
});
