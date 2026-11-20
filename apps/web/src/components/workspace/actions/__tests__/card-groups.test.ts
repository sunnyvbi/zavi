
import { describe, expect, it } from "vitest";
import { cardCount, groupByTarget, groupKey, targetOf } from "../cardGroups";
import { makeAction } from "./fixtures";
import type { ChannelActionView } from "@/lib/workspace/channelActionsApi";

const at = (id: string, target?: { kind: string; ref: string }): ChannelActionView =>
  makeAction("update_ad", { id, body: target ? { step: { target } as never } : {} });

describe("targetOf / groupKey", () => {
  it("keys on kind and ref, ignoring case and extra spaces", () => {
    expect(groupKey(at("a", { kind: "campaign", ref: "  Spring   Sale " }))).toBe("campaign:spring sale");
    expect(groupKey(at("b", { kind: "campaign", ref: "spring sale" }))).toBe("campaign:spring sale");
  });

  it("never groups on a catch-all target, an empty ref or no target", () => {
    expect(targetOf(at("a", { kind: "queue", ref: "inbox" }))).toBeNull();
    expect(targetOf(at("b", { kind: "other", ref: "x" }))).toBeNull();
    expect(targetOf(at("c", { kind: "page", ref: "   " }))).toBeNull();
    expect(targetOf(at("d"))).toBeNull();
  });
});

describe("groupByTarget", () => {
  it("folds cards on one target into one group at the best-ranked member's place", () => {
    const list = [
      at("1", { kind: "campaign", ref: "Brand" }),
      at("2", { kind: "page", ref: "/pricing" }),
      at("3", { kind: "campaign", ref: "brand" }),
      at("4"),
    ];
    const out = groupByTarget(list);
    expect(out.map((e) => (e.kind === "group" ? `G[${e.members.map((m) => m.id).join(",")}]` : e.card.id))).toEqual([
      "G[1,3]",
      "2",
      "4",
    ]);
    expect(cardCount(out)).toBe(4);
  });

  it("a group counts as ONE of the five places on screen", () => {
    const list = [
      at("1", { kind: "ad_set", ref: "A" }),
      at("2", { kind: "ad_set", ref: "A" }),
      at("3", { kind: "ad_set", ref: "A" }),
      at("4"),
      at("5"),
      at("6"),
      at("7"),
      at("8"),
    ];
    const five = groupByTarget(list).slice(0, 5);
    expect(five).toHaveLength(5);
    expect(cardCount(five)).toBe(7);
  });

  it("a target with one card is a plain card, not a group of one", () => {
    const out = groupByTarget([at("1", { kind: "campaign", ref: "Brand" }), at("2")]);
    expect(out.every((e) => e.kind === "card")).toBe(true);
  });

  it("never groups a card the caller marks as not groupable (staged, check)", () => {
    const list = [
      at("check:profile", { kind: "profile", ref: "me" }),
      at("5", { kind: "profile", ref: "me" }),
      at("6", { kind: "profile", ref: "me" }),
    ];
    const out = groupByTarget(list, (c) => !c.id.startsWith("check:"));
    expect(out.map((e) => (e.kind === "group" ? `G[${e.members.map((m) => m.id).join(",")}]` : e.card.id))).toEqual([
      "check:profile",
      "G[5,6]",
    ]);
  });
});
