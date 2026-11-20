import { describe, it, expect } from "vitest";
import {
  applyStreamDraftUpdate,
  EMPTY_DRAFT_ACCUM,
  type StreamDraftAccum,
} from "./useRunStreamDraft";

describe("applyStreamDraftUpdate — ordered draft assembly", () => {
  it("applies an in-order sequence of cumulative updates", () => {
    let s: StreamDraftAccum = EMPTY_DRAFT_ACCUM;
    s = applyStreamDraftUpdate(s, { seq: 1, text: "Hel", status: "streaming" });
    expect(s.text).toBe("Hel");
    s = applyStreamDraftUpdate(s, { seq: 2, text: "Hello", status: "streaming" });
    expect(s.text).toBe("Hello");
    s = applyStreamDraftUpdate(s, {
      seq: 3,
      text: "Hello world",
      status: "streaming",
    });
    expect(s.text).toBe("Hello world");
    expect(s.lastSeq).toBe(3);
  });

  it("DROPS an out-of-order (lower seq) update — text never flickers backwards", () => {
    let s: StreamDraftAccum = EMPTY_DRAFT_ACCUM;
    s = applyStreamDraftUpdate(s, { seq: 5, text: "latest", status: "streaming" });
    const before = s;
    s = applyStreamDraftUpdate(s, { seq: 3, text: "stale", status: "streaming" });
    expect(s).toBe(before);
    expect(s.text).toBe("latest");
  });

  it("DROPS a duplicate (equal seq) update", () => {
    let s: StreamDraftAccum = EMPTY_DRAFT_ACCUM;
    s = applyStreamDraftUpdate(s, { seq: 2, text: "v2", status: "streaming" });
    const before = s;
    s = applyStreamDraftUpdate(s, { seq: 2, text: "v2-dup", status: "streaming" });
    expect(s).toBe(before);
    expect(s.text).toBe("v2");
  });

  it("coerces a string seq (PostgREST bigint serializes as string)", () => {
    let s: StreamDraftAccum = EMPTY_DRAFT_ACCUM;
    s = applyStreamDraftUpdate(s, {
      seq: "1",
      text: "a",
      status: "streaming",
    });
    s = applyStreamDraftUpdate(s, {
      seq: "2",
      text: "ab",
      status: "streaming",
    });
    expect(s.text).toBe("ab");
    expect(s.lastSeq).toBe(2);
  });

  it("carries the terminal status through (the 'complete' drop signal)", () => {
    let s: StreamDraftAccum = EMPTY_DRAFT_ACCUM;
    s = applyStreamDraftUpdate(s, { seq: 1, text: "done text", status: "streaming" });
    s = applyStreamDraftUpdate(s, { seq: 2, text: "done text", status: "complete" });
    expect(s.status).toBe("complete");
    expect(s.text).toBe("done text");
  });

  it("ignores a non-finite seq", () => {
    let s: StreamDraftAccum = EMPTY_DRAFT_ACCUM;
    const before = s;
    s = applyStreamDraftUpdate(s, {
      seq: "not-a-number",
      text: "x",
      status: "streaming",
    });
    expect(s).toBe(before);
  });
});
