import { describe, it, expect } from "vitest";
import { decisionRunsOf, lastTurnRowIndex, type TimelineEntry } from "./threadTimeline";

type R = { kind: string; id: string };
const row = (kind: string, id: string, index: number): TimelineEntry<R, never> => ({ kind: "row", row: { kind, id }, index, at: "" });

describe("decisionRunsOf", () => {
  it("groups two or more decision rows in a row; a lone card is left alone", () => {
    const t = [row("chat_user", "u", 0), row("decision", "a", 1), row("decision", "b", 2), row("decision", "c", 3), row("chat_assistant", "r", 4), row("decision", "d", 5)];
    const m = decisionRunsOf(t);
    expect(m.get(1)?.map((x) => x.row.id)).toEqual(["a", "b", "c"]);
    expect(m.get(2)).toBeNull();
    expect(m.get(3)).toBeNull();
    expect(m.has(5)).toBe(false);
    expect(m.has(0)).toBe(false);
  });
});

describe("lastTurnRowIndex", () => {
  it("skips the cards under the latest reply", () => {
    expect(lastTurnRowIndex([{ kind: "chat_user" }, { kind: "chat_assistant" }, { kind: "decision" }, { kind: "decision" }])).toBe(1);
  });
  it("is the last row when it is not a card, and -1 for only cards", () => {
    expect(lastTurnRowIndex([{ kind: "chat_assistant" }, { kind: "chat_user" }])).toBe(1);
    expect(lastTurnRowIndex([{ kind: "decision" }])).toBe(-1);
  });
});
