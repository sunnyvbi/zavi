import { describe, expect, it } from "vitest";
import { READER_NOTE, shouldAddReaderNote, withReaderNote } from "../reader-note";

describe("shouldAddReaderNote", () => {
  it.each(["chat", "slack", "teams", "telegram", "discord", "whatsapp", "email"])(
    "is on for operator on %s",
    (trigger) => {
      expect(shouldAddReaderNote({ agentSlug: "operator", trigger })).toBe(true);
    },
  );

  it("is off for engineer, and for operator on non-conversational triggers", () => {
    expect(shouldAddReaderNote({ agentSlug: "engineer", trigger: "chat" })).toBe(false);
    expect(shouldAddReaderNote({ agentSlug: "operator", trigger: "handoff" })).toBe(false);
    expect(shouldAddReaderNote({ agentSlug: "operator", trigger: "cron" })).toBe(false);
    expect(shouldAddReaderNote({ agentSlug: "operator", trigger: undefined })).toBe(false);
  });
});

describe("withReaderNote", () => {
  it("puts the note last in a string turn", () => {
    expect(withReaderNote("how does it work?")).toBe(`how does it work?\n\n${READER_NOTE}`);
    expect(withReaderNote("")).toBe(READER_NOTE);
  });

  it("appends to the trailing text block of an image turn, once, without mutating the shared array", () => {
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "x" } } as const;
    const shared = [image, { type: "text" as const, text: "what is this?" }];
    const out = withReaderNote(shared);
    expect(shared[1]).toEqual({ type: "text", text: "what is this?" });
    expect(out).toEqual([image, { type: "text", text: `what is this?\n\n${READER_NOTE}` }]);
    expect(JSON.stringify(out).split("Reader: this person").length - 1).toBe(1);
  });

  it("is idempotent", () => {
    const once = withReaderNote("q");
    expect(withReaderNote(once)).toBe(once);
    const arr = withReaderNote([{ type: "text", text: "q" }]);
    expect(withReaderNote(arr)).toEqual(arr);
  });

  it("adds a text block when the turn ends in a non-text block", () => {
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "x" } } as const;
    expect(withReaderNote([image])).toEqual([image, { type: "text", text: READER_NOTE }]);
  });
});
