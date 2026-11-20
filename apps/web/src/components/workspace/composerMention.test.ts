import { describe, expect, it } from "vitest";
import {
  getActiveComposerMention,
  removeActiveComposerMention,
  replaceActiveComposerMention,
  shouldShowComposerHint,
  splitComposerAtMention,
} from "./composerMention";

describe("composer mentions", () => {
  it("opens a mention after existing prompt text", () => {
    expect(getActiveComposerMention("create a post draft @")).toEqual({
      query: "",
      start: 20,
      end: 21,
    });
    expect(getActiveComposerMention("create a post draft @meta")).toEqual({
      query: "meta",
      start: 20,
      end: 25,
    });
  });

  it("still recognizes a mention at the start", () => {
    expect(getActiveComposerMention("@google")).toEqual({
      query: "google",
      start: 0,
      end: 7,
    });
  });

  it("closes after the mention token is complete", () => {
    expect(getActiveComposerMention("create @meta campaign")).toBeNull();
    expect(getActiveComposerMention("email@example.com")).toBeNull();
  });

  it("removes only the active mention token", () => {
    expect(removeActiveComposerMention("create a post draft @meta")).toEqual({
      value: "create a post draft ",
      caret: 20,
    });
    expect(removeActiveComposerMention("@meta")).toEqual({
      value: "",
      caret: 0,
    });
  });

  it("removes the active token and returns its logical chip position", () => {
    expect(replaceActiveComposerMention("create a draft for @meta")).toEqual({
      value: "create a draft for ",
      caret: 19,
    });
  });

  it("recognizes and replaces a mention at the caret without deleting suffix text", () => {
    const value = "create @meta campaign";
    expect(getActiveComposerMention(value, 12)).toEqual({
      query: "meta",
      start: 7,
      end: 12,
    });
    expect(replaceActiveComposerMention(value, 12)).toEqual({
      value: "create  campaign",
      caret: 7,
    });
  });

  it("splits plain composer text around the selected chip position", () => {
    expect(splitComposerAtMention("create a draft for where you need", 19)).toEqual({
      before: "create a draft for ",
      after: "where you need",
    });
  });

  it("clamps an invalid chip position", () => {
    expect(splitComposerAtMention("draft", 99)).toEqual({
      before: "draft",
      after: "",
    });
  });

  it("hides passive helper text while a selected tool is inline", () => {
    expect(
      shouldShowComposerHint(
        "Put this to Meta Ads. The answer comes back here.",
        true,
      ),
    ).toBe(false);
    expect(shouldShowComposerHint("Unknown command.", false)).toBe(true);
  });
});
