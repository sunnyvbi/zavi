import { describe, it, expect } from "vitest";
import {
  shouldBlockSend,
  shouldTransparentlyHealThread,
  resolveSeedDrain,
  sendFailureInputPolicy,
  mayReplaceWithSeed,
} from "./composerGuards";

describe("Composer — shouldBlockSend (belt-and-suspenders whitespace guard)", () => {
  it("blocks send when value is purely ASCII whitespace and no images attached", () => {
    expect(
      shouldBlockSend({
        value: "   ",
        readyImagePathsCount: 0,
        inflight: false,
        submittingFeedback: false,
      }),
    ).toBe(true);
  });

  it("allows send when value is empty but a doc attachment is ready (doc-only turn)", () => {
    expect(
      shouldBlockSend({
        value: "",
        readyImagePathsCount: 0,
        readyDocPathsCount: 1,
        inflight: false,
        submittingFeedback: false,
      }),
    ).toBe(false);
  });

  it("still blocks an empty doc-only turn while a run is inflight", () => {
    expect(
      shouldBlockSend({
        value: "",
        readyImagePathsCount: 0,
        readyDocPathsCount: 1,
        inflight: true,
        submittingFeedback: false,
      }),
    ).toBe(true);
  });

  it("allows send when value is empty but a video is ready (video-only turn)", () => {
    expect(
      shouldBlockSend({
        value: "",
        readyImagePathsCount: 0,
        readyVideoPathsCount: 1,
        inflight: false,
        submittingFeedback: false,
      }),
    ).toBe(false);
  });

  it("still blocks an empty video-only turn while a run is inflight", () => {
    expect(
      shouldBlockSend({
        value: "",
        readyImagePathsCount: 0,
        readyVideoPathsCount: 1,
        inflight: true,
        submittingFeedback: false,
      }),
    ).toBe(true);
  });

  it("blocks send when value is unicode whitespace (U+00A0 nbsp, U+2003 em-space) — \\s with u flag catches both", () => {
    expect(
      shouldBlockSend({
        value: "   ",
        readyImagePathsCount: 0,
        inflight: false,
        submittingFeedback: false,
      }),
    ).toBe(true);
  });

  it("blocks send when value is zero-width chars (U+200B ZWSP, U+200C ZWNJ, U+200D ZWJ, U+2060 WJ) — prior \\s-only predicate let these through", () => {
    expect(
      shouldBlockSend({
        value: "​‌‍⁠",
        readyImagePathsCount: 0,
        inflight: false,
        submittingFeedback: false,
      }),
    ).toBe(true);
  });

  it("blocks send when value MIXES unicode whitespace AND zero-width invisibles (the actual /qa-blind T5 prod repro shape)", () => {
    expect(
      shouldBlockSend({
        value: "  ​",
        readyImagePathsCount: 0,
        inflight: false,
        submittingFeedback: false,
      }),
    ).toBe(true);
  });

  it("blocks send when value is BOM only (U+FEFF) — leaks in from clipboard / file-paste", () => {
    expect(
      shouldBlockSend({
        value: "﻿﻿",
        readyImagePathsCount: 0,
        inflight: false,
        submittingFeedback: false,
      }),
    ).toBe(true);
  });

  it("allows send when zero-width-joiner is part of a compound emoji (ZWJ in real content must NOT gate the send)", () => {
    expect(
      shouldBlockSend({
        value: "\u{1F468}‍\u{1F469}‍\u{1F467}",
        readyImagePathsCount: 0,
        inflight: false,
        submittingFeedback: false,
      }),
    ).toBe(false);
  });

  it("blocks send when value is empty and no images attached", () => {
    expect(
      shouldBlockSend({
        value: "",
        readyImagePathsCount: 0,
        inflight: false,
        submittingFeedback: false,
      }),
    ).toBe(true);
  });

  it("blocks send when value is tabs+newlines+spaces only", () => {
    expect(
      shouldBlockSend({
        value: "\t \n \r  ",
        readyImagePathsCount: 0,
        inflight: false,
        submittingFeedback: false,
      }),
    ).toBe(true);
  });

  it("allows send when value is whitespace BUT images are attached (image-only turn)", () => {
    expect(
      shouldBlockSend({
        value: "   ",
        readyImagePathsCount: 2,
        inflight: false,
        submittingFeedback: false,
      }),
    ).toBe(false);
  });

  it("allows send when value has real content", () => {
    expect(
      shouldBlockSend({
        value: "hello",
        readyImagePathsCount: 0,
        inflight: false,
        submittingFeedback: false,
      }),
    ).toBe(false);
  });

  it("allows send when value has content with leading/trailing whitespace", () => {
    expect(
      shouldBlockSend({
        value: "  hello  ",
        readyImagePathsCount: 0,
        inflight: false,
        submittingFeedback: false,
      }),
    ).toBe(false);
  });

  it("allows send when value mixes invisibles WITH visible text (real content present)", () => {
    expect(
      shouldBlockSend({
        value: " ​hello‌",
        readyImagePathsCount: 0,
        inflight: false,
        submittingFeedback: false,
      }),
    ).toBe(false);
  });

  it("blocks send when inflight regardless of content", () => {
    expect(
      shouldBlockSend({
        value: "hello",
        readyImagePathsCount: 0,
        inflight: true,
        submittingFeedback: false,
      }),
    ).toBe(true);
  });

  it("blocks send when submittingFeedback regardless of content", () => {
    expect(
      shouldBlockSend({
        value: "hello",
        readyImagePathsCount: 0,
        inflight: false,
        submittingFeedback: true,
      }),
    ).toBe(true);
  });
});

describe("Composer — shouldTransparentlyHealThread (transparent thread-heal)", () => {
  const base = {
    errorCode: "thread_not_found" as string | null | undefined,
    targetSlug: "advisor",
    agentSlug: "advisor",
    sentThreadId: "foreign-thread-uuid" as string | null,
  };

  it("heals: thread_not_found on THIS tab's own non-null bound thread (the crux)", () => {
    expect(shouldTransparentlyHealThread(base)).toBe(true);
  });

  it("does NOT heal a fresh send (sentThreadId already null) — a 404 there is a real failure", () => {
    expect(shouldTransparentlyHealThread({ ...base, sentThreadId: null })).toBe(false);
  });

  it("does NOT heal a /@other-routed send (targetSlug !== agentSlug — it sent null anyway)", () => {
    expect(
      shouldTransparentlyHealThread({ ...base, targetSlug: "engineer" }),
    ).toBe(false);
  });

  it("does NOT heal a non-thread_not_found error (network / other backend error)", () => {
    expect(shouldTransparentlyHealThread({ ...base, errorCode: "rate_limited" })).toBe(false);
    expect(shouldTransparentlyHealThread({ ...base, errorCode: null })).toBe(false);
    expect(shouldTransparentlyHealThread({ ...base, errorCode: undefined })).toBe(false);
  });
});

describe("Composer — resolveSeedDrain (seed-drain decision)", () => {
  it("returns none when there is no pending seed", () => {
    expect(
      resolveSeedDrain({ seed: undefined, hasTypedText: false, alreadyFired: false }),
    ).toEqual({ kind: "none" });
  });

  it("prefills (Change… path) when the box is empty and the seed is not autoSend", () => {
    expect(
      resolveSeedDrain({
        seed: { text: "", nonce: 1 },
        hasTypedText: false,
        alreadyFired: false,
      }),
    ).toEqual({ kind: "prefill", text: "" });
  });

  it("autosends (Looks good path) when the box is empty and the seed is autoSend, not yet fired", () => {
    expect(
      resolveSeedDrain({
        seed: { text: "build it", nonce: 5, autoSend: true },
        hasTypedText: false,
        alreadyFired: false,
      }),
    ).toEqual({ kind: "autosend", text: "build it" });
  });

  it("NEVER clobbers an in-progress draft — focus_only even for an autoSend seed", () => {
    expect(
      resolveSeedDrain({
        seed: { text: "build it", nonce: 5, autoSend: true },
        hasTypedText: true,
        alreadyFired: false,
      }),
    ).toEqual({ kind: "focus_only" });
    expect(
      resolveSeedDrain({
        seed: { text: "", nonce: 2 },
        hasTypedText: true,
        alreadyFired: false,
      }),
    ).toEqual({ kind: "focus_only" });
  });

  it("fires an autoSend seed EXACTLY ONCE — a re-invoke of the SAME seed (alreadyFired) is focus_only", () => {
    const seed = { text: "build it", nonce: 7, autoSend: true };
    expect(
      resolveSeedDrain({ seed, hasTypedText: false, alreadyFired: false }),
    ).toEqual({ kind: "autosend", text: "build it" });
    expect(
      resolveSeedDrain({ seed, hasTypedText: false, alreadyFired: true }),
    ).toEqual({ kind: "focus_only" });
  });

  it("a NEW autoSend seed fires again even though its nonce reset to 1 — the guard is per-seed-object, not per-nonce (regression: consumeComposerSeed resets the nonce)", () => {
    expect(
      resolveSeedDrain({
        seed: { text: "build it", nonce: 1, autoSend: true },
        hasTypedText: false,
        alreadyFired: false,
      }),
    ).toEqual({ kind: "autosend", text: "build it" });
  });
});

describe("Composer — sendFailureInputPolicy (what a blocked send does with the text)", () => {
  it("clears the box when the send was blocked for credits", () => {
    expect(sendFailureInputPolicy("credits")).toEqual({
      restoreInput: false,
      retryBanner: false,
    });
  });

  it("restores the text for a wrong-workspace command, but promises no retry", () => {
    expect(sendFailureInputPolicy("invalid_command")).toEqual({
      restoreInput: true,
      retryBanner: false,
    });
  });

  it("restores the text AND offers the retry banner on a retryable failure", () => {
    expect(sendFailureInputPolicy("failed")).toEqual({
      restoreInput: true,
      retryBanner: true,
    });
  });
});

describe("Composer — mayReplaceWithSeed (external prefill seed)", () => {
  it("fills an empty or whitespace-only box", () => {
    expect(mayReplaceWithSeed({ current: "", lastSeeded: null })).toBe(true);
    expect(mayReplaceWithSeed({ current: "  \n", lastSeeded: null })).toBe(true);
  });
  it("NEVER replaces text the founder typed", () => {
    expect(mayReplaceWithSeed({ current: "what about my blog?", lastSeeded: null })).toBe(false);
    expect(mayReplaceWithSeed({ current: "Fix: titles. also my blog", lastSeeded: "Fix: titles." })).toBe(false);
  });
  it("swaps an untouched earlier seed for the next one", () => {
    expect(mayReplaceWithSeed({ current: "Fix: titles.", lastSeeded: "Fix: titles." })).toBe(true);
  });
});
