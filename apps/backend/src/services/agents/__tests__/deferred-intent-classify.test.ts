import { describe, it, expect } from "vitest";

import { isDeferredIntentRequest } from "../deferred-intent-classify";

describe("isDeferredIntentRequest", () => {
  it("matches unambiguous reminder requests", () => {
    for (const m of [
      "Remind me in one hour to check this",
      "remind me tomorrow",
      "set a reminder to review the PR",
      "set an reminder",
      "give me a nudge later",
    ]) {
      expect(isDeferredIntentRequest(m), m).toBe(true);
    }
  });

  it("matches soft notify/follow-up verbs ONLY with a deferral cue", () => {
    expect(isDeferredIntentRequest("ping me in 30 minutes about this")).toBe(true);
    expect(isDeferredIntentRequest("follow up with me later")).toBe(true);
    expect(isDeferredIntentRequest("circle back tonight")).toBe(true);
    expect(isDeferredIntentRequest("dm me once the deploy finishes")).toBe(true);
    expect(isDeferredIntentRequest("in an hour, ping me to re-check")).toBe(true);
  });

  it("matches widened deferral cues (clock times + weekdays) — prosecutor false-negatives", () => {
    expect(isDeferredIntentRequest("ping me at 5pm to check this")).toBe(true);
    expect(isDeferredIntentRequest("follow up with me at 9am")).toBe(true);
    expect(isDeferredIntentRequest("ping me next monday about the PR")).toBe(true);
    expect(isDeferredIntentRequest("circle back end of day")).toBe(true);
    expect(isDeferredIntentRequest("follow up with me on friday")).toBe(true);
  });

  it("does NOT fire on immediate 'send me X now' requests (no deferral cue)", () => {
    for (const m of [
      "dm me the PR link",
      "ping me the file",
      "message me the results",
      "email me the report",
      "text me the address",
    ]) {
      expect(isDeferredIntentRequest(m), m).toBe(false);
    }
  });

  it("does NOT fire on ordinary follow-up edits without reminder framing", () => {
    for (const m of [
      "also rename the button to Save",
      "actually use blue",
      "you forgot to push the dist files",
      "",
    ]) {
      expect(isDeferredIntentRequest(m), m).toBe(false);
    }
  });
});
