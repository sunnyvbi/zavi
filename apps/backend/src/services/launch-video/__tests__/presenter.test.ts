import { describe, it, expect } from "vitest";
import {
  FALLBACK_VOICE,
  PRESENTER_VOICES,
  UNSPECIFIED_PRESENTER_VOICE,
  resolvePresenterVoice,
  talkingHeadPortraitPrompt,
} from "../presenter";
import { generativeVideoIntakeSchema } from "../generative-video-intake";

describe("resolvePresenterVoice", () => {
  it("keeps a voice that matches the presenter, whatever its casing", () => {
    expect(resolvePresenterVoice({ gender: "female", voice: "Sarah" })).toBe("Sarah");
    expect(resolvePresenterVoice({ gender: "male", voice: " will " })).toBe("Will");
  });

  it("never lets a presenter be read by a voice of the other gender", () => {
    for (const [voice, gender] of Object.entries(PRESENTER_VOICES)) {
      const other = gender === "male" ? "female" : "male";
      expect(PRESENTER_VOICES[resolvePresenterVoice({ gender: other, voice })], voice).toBe(other);
    }
  });

  it("falls back by gender when the voice is missing or one the vendor does not have", () => {
    expect(resolvePresenterVoice({ gender: "female" })).toBe(FALLBACK_VOICE.female);
    expect(resolvePresenterVoice({ gender: "male", voice: "Rachel2" })).toBe(FALLBACK_VOICE.male);
    expect(PRESENTER_VOICES[FALLBACK_VOICE.male]).toBe("male");
    expect(PRESENTER_VOICES[FALLBACK_VOICE.female]).toBe("female");
  });

  it("with no presenter named, a voice is never used: there is nothing to check it against", () => {
    expect(resolvePresenterVoice({})).toBe(UNSPECIFIED_PRESENTER_VOICE);
    expect(resolvePresenterVoice({ voice: "Jessica" })).toBe(UNSPECIFIED_PRESENTER_VOICE);
    expect(resolvePresenterVoice({ voice: "not-a-voice" })).toBe(UNSPECIFIED_PRESENTER_VOICE);
  });
});

describe("talkingHeadPortraitPrompt", () => {
  it("names the presenter, keeps the scene, and asks for a frame the video model and the captions can use", () => {
    const p = talkingHeadPortraitPrompt("A florist in her forties in her shop, green apron.", "female");
    expect(p).toContain("a woman");
    expect(p).toContain("The person on camera is a woman");
    expect(p).toContain("A florist in her forties in her shop, green apron");
    expect(p).toContain("Hands out of frame");
    expect(p).toContain("upper half of the frame");
    expect(p).not.toContain("..");
  });

  it("says nothing about gender when none was given", () => {
    const p = talkingHeadPortraitPrompt("a founder explaining the product");
    expect(p).toContain("a presenter");
    expect(p).not.toMatch(/a (wo)?man\b/);
  });
});

describe("intake", () => {
  it("accepts a card written before the presenter fields existed", () => {
    const r = generativeVideoIntakeSchema.safeParse({ prompt: "a presenter", intent: "talking_head", script: "Six words is the minimum here." });
    expect(r.success).toBe(true);
  });

  it("carries the presenter and voice, and refuses a gender it does not know", () => {
    const base = { prompt: "a presenter", intent: "talking_head", script: "Six words is the minimum here." };
    expect(generativeVideoIntakeSchema.parse({ ...base, presenter_gender: "female", voice: "Jessica" })).toMatchObject({ presenter_gender: "female", voice: "Jessica" });
    expect(generativeVideoIntakeSchema.safeParse({ ...base, presenter_gender: "robot" }).success).toBe(false);
  });

  it("refuses a voice with no presenter gender (a male presenter described in the prompt, read by Jessica)", () => {
    const r = generativeVideoIntakeSchema.safeParse({
      prompt: "A male founder speaking from his office",
      intent: "talking_head",
      script: "Six words is the minimum here.",
      voice: "Jessica",
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].path).toEqual(["presenter_gender"]);
  });
});
