import { describe, expect, it } from "vitest";
import { hideCardsWhileFiling, originLabel } from "./threadTimeline";

const row = (id: string, kind: string, run: string | null, at: string) => ({ id, kind, agent_run_id: run, created_at: at });

describe("hideCardsWhileFiling", () => {
  const rows = [
    row("ask", "chat_user", "run-1", "2026-10-23T18:00:00Z"),
    row("old-card", "decision", "run-0", "2026-10-22T10:00:00Z"),
    row("raise", "decision", "run-1", "2026-10-23T18:00:20Z"),
    row("moved", "decision", "run-0", "2026-10-23T18:00:30Z"),
    row("note", "chat_assistant", "run-0", "2026-10-23T18:00:40Z"),
  ];

  it("must-catch e1da4894: the in-flight run's cards and cards written since the turn began are hidden", () => {
    const shown = hideCardsWhileFiling(rows, { run_id: "run-1", since: "2026-10-23T18:00:00Z" }).map((r) => r.id);
    expect(shown).toEqual(["ask", "old-card", "note"]);
  });

  it("with nothing in flight every row shows", () => {
    expect(hideCardsWhileFiling(rows, null).map((r) => r.id)).toEqual(rows.map((r) => r.id));
  });

  it("without a turn start only the in-flight run's own cards are hidden", () => {
    expect(hideCardsWhileFiling(rows, { run_id: "run-1", since: null }).map((r) => r.id)).toEqual(["ask", "old-card", "moved", "note"]);
  });
});

describe("originLabel", () => {
  it("a card from another chat says the day it was filed", () => {
    expect(originLabel({ from_other_chat: true, filed_at: "2026-10-20T18:00:00Z" }, "en-US", "UTC")).toBe("From your Oct 20 chat");
  });

  it("no label without the server's mark or with a bad date", () => {
    expect(originLabel({ filed_at: "2026-10-20T18:00:00Z" }, "en-US", "UTC")).toBeNull();
    expect(originLabel({ from_other_chat: true, filed_at: "nope" }, "en-US", "UTC")).toBeNull();
    expect(originLabel(null)).toBeNull();
  });
});
