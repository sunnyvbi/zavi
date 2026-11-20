import { describe, expect, it } from "vitest";
import { FIRST_DRAFT_MESSAGE, firstDraftShownMessage } from "./firstView";

describe("firstDraftShownMessage", () => {
  it("reads a draft message from the framed origin only", () => {
    expect(firstDraftShownMessage({ type: FIRST_DRAFT_MESSAGE, shown: true }, "https://a", "https://a")).toBe(true);
    expect(firstDraftShownMessage({ type: FIRST_DRAFT_MESSAGE, shown: false }, "https://a", "https://a")).toBe(false);
    expect(firstDraftShownMessage({ type: FIRST_DRAFT_MESSAGE, shown: true }, "https://b", "https://a")).toBeNull();
    expect(firstDraftShownMessage({ type: "x", shown: true }, "https://a", "https://a")).toBeNull();
    expect(firstDraftShownMessage(null, "https://a", "https://a")).toBeNull();
  });
});
