
import { describe, expect, it } from "vitest";
import { cardsOnScreen, laneKinds } from "../ChannelActionsLane";
import { cardKind } from "../registry";
import type { LaneEntry } from "../cardGroups";
import type { ActionItem } from "../types";

const card = (id: string, action_type: string, intent?: string) =>
  ({ id, action_type, body: intent ? { intent } : {} }) as unknown as ActionItem;
const entries = (cards: ActionItem[]): LaneEntry<ActionItem>[] => cards.map((c) => ({ kind: "card", card: c }));

describe("one card per kind", () => {
  it("buckets in rank order and shows the best-ranked card of each kind", () => {
    const pool = [card("p1", "text_post"), card("r1", "reply"), card("p2", "image_post"), card("c1", "check"), card("p3", "video_post")];
    const kinds = laneKinds(entries(pool), [], new Set(), () => {});
    expect(kinds.map((k) => [k.label, k.entries.length])).toEqual([["Posts", 3], ["Replies", 1], ["Checks", 1]]);
    expect(cardsOnScreen(kinds).map((c) => c.id)).toEqual(["p1", "r1", "c1"]);
  });

  it("an open kind shows all of its cards, the others stay at one", () => {
    const pool = [card("p1", "text_post"), card("p2", "text_post"), card("r1", "reply"), card("r2", "reply")];
    const kinds = laneKinds(entries(pool), [], new Set(["Post"]), () => {});
    expect(cardsOnScreen(kinds).map((c) => c.id)).toEqual(["p1", "p2", "r1"]);
  });

  it("a setup to-do is its own kind, whatever its type", () => {
    expect(cardKind(card("f", "fix", "fix_setup"))).toBe("Setup fix");
    expect(cardKind(card("c", "check", "fix_setup"))).toBe("Setup fix");
    expect(cardKind(card("x", "fix", "improve"))).toBe("Fix");
    expect(cardKind(card("u", "not_a_type"))).toBe("To do");
  });

  it("a kind another list already shows (the creator cards) keeps every card behind its toggle", () => {
    const pool = [card("o", "other"), card("m", "send_message")];
    const kinds = laneKinds(entries(pool), ["To do"], new Set(), () => {});
    expect(cardsOnScreen(kinds).map((c) => c.id)).toEqual(["m"]);
    expect(kinds.find((k) => k.kind === "To do")?.entries).toHaveLength(1);
  });
});
