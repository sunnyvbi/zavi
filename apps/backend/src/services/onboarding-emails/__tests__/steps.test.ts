
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  ONBOARDING_SRC_RE,
  SEQUENCE_STEPS,
  channelSlugFor,
  destinationUrl,
  nextStepAfter,
  stepByNumber,
} from "../steps";

const CHANNELS_DIR = join(__dirname, "../../../channels");
const IMAGES_DIR = join(__dirname, "../../../../../web/public/email/onboarding");
const WS = "https://www.zaviagent.com/workspace";

describe("sequence schedule", () => {
  it("is the eight emails on eight consecutive days, 0 to 7 (no email 5)", () => {
    expect(SEQUENCE_STEPS.map((s) => s.step)).toEqual([1, 2, 3, 4, 6, 7, 8, 9]);
    expect(SEQUENCE_STEPS.map((s) => s.day)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("never has two emails on one day", () => {
    const days = SEQUENCE_STEPS.map((s) => s.day);
    expect(new Set(days).size).toBe(days.length);
  });

  it("walks forward one email at a time and ends", () => {
    expect(nextStepAfter(0)?.step).toBe(1);
    expect(nextStepAfter(4)?.step).toBe(6);
    expect(nextStepAfter(9)).toBeUndefined();
    expect(stepByNumber(5)).toBeUndefined();
  });
});

describe("destination links", () => {
  it("opens the workspace, Growth Strategy, and a channel, tagged with the email number", () => {
    expect(destinationUrl("workspace", WS, 1)).toBe(`${WS}?src=onb_1`);
    expect(destinationUrl("growth_strategy", WS, 2)).toBe(`${WS}?tab=growth-strategy&src=onb_2`);
    expect(destinationUrl("seo_geo", WS, 3)).toBe(`${WS}?tab=channels&channel=seo&src=onb_3`);
  });

  it("every email's button carries its own number and nothing else new", () => {
    for (const s of SEQUENCE_STEPS) {
      const url = new URL(destinationUrl(s.destination, WS, s.step));
      expect(url.searchParams.get("src"), `email ${s.step}`).toBe(`onb_${s.step}`);
      expect(ONBOARDING_SRC_RE.test(url.searchParams.get("src") ?? ""), `email ${s.step}`).toBe(true);
      const keys = [...url.searchParams.keys()].filter((k) => k !== "src");
      const slug = channelSlugFor(s.destination);
      const expected = slug ? ["tab", "channel"] : s.destination === "growth_strategy" ? ["tab"] : [];
      expect(keys, `email ${s.step}`).toEqual(expected);
    }
  });

  it("every channel button names a channel that exists", () => {
    const real = new Set(readdirSync(CHANNELS_DIR));
    for (const s of SEQUENCE_STEPS) {
      const slug = channelSlugFor(s.destination);
      if (slug) expect(real.has(slug), `${s.destination} -> ${slug}`).toBe(true);
    }
  });
});

describe("copy", () => {
  it("the search and social emails say the founder approves before anything goes out", () => {
    expect(stepByNumber(3)?.paragraphs).toContain(
      "I do the research and write the drafts. You approve before anything changes on your site.",
    );
    expect(stepByNumber(4)?.paragraphs).toContain("I write the posts. You approve each one before it goes out.");
    for (const n of [3, 4]) {
      expect(stepByNumber(n)?.paragraphs.join(" "), `email ${n}`).not.toMatch(/don’t have to manage/);
    }
  });

  it("the welcome promises the plan, not running channels; the Growth Strategy email says channel runs need a paid plan", () => {
    expect(stepByNumber(1)?.afterButton).toBe("Your growth plan will be ready in about 15 minutes. I’ll email you when it is.");
    expect(stepByNumber(1)?.afterButton).not.toMatch(/channels are running/i);
    const growth = stepByNumber(2)?.paragraphs.join(" ") ?? "";
    expect(growth).toContain("Running channels for you needs a paid plan.");
    expect(growth).not.toMatch(/keep working toward your goal/);
  });
});

describe("pictures", () => {
  it("each email has its own picture, present and compressed", () => {
    const files = SEQUENCE_STEPS.map((s) => s.image);
    expect(new Set(files).size).toBe(files.length);
    for (const f of files) {
      const p = `${IMAGES_DIR}/${f}`;
      expect(existsSync(p), p).toBe(true);
      expect(statSync(p).size, `${f} is too big for an email`).toBeLessThan(60_000);
    }
  });

  it("every picture has a description for people who cannot see it", () => {
    for (const s of SEQUENCE_STEPS) expect(s.alt.length).toBeGreaterThan(10);
  });
});
