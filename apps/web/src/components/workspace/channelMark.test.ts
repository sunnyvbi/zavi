import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CHANNELS } from "@zavi/shared";
import { channelMark, isPaidChannel, MARKED_SLUGS } from "./channelMark";

const PUBLIC_DIR = join(__dirname, "../../../public");

describe("channelMark", () => {
  it("gives every registry channel a mark of its own, not a fallback", () => {
    const unmapped = CHANNELS.map((c) => c.slug).filter(
      (s) => !MARKED_SLUGS.includes(s),
    );
    expect(unmapped).toEqual([]);
  });

  it("actually RESOLVES every registry channel — set membership is not a lookup", () => {
    const fellBack = CHANNELS.filter(
      (c) => channelMark(c.slug) === channelMark("no-such-channel-at-all"),
    ).map((c) => c.slug);
    expect(fellBack).toEqual([]);
  });

  it("points at files that are really on disk", () => {
    const missing = CHANNELS.map((c) => channelMark(c.slug))
      .filter((m) => m.kind === "logo")
      .map((m) => (m as { src: string }).src)
      .filter((src) => !existsSync(join(PUBLIC_DIR, src)));
    expect(missing).toEqual([]);
  });

  it("agrees with the registry about who is paid", () => {
    for (const c of CHANNELS) {
      expect(isPaidChannel(c.slug), c.slug).toBe(c.category === "paid");
    }
  });

  it("never resolves to a third-party URL", () => {
    for (const c of CHANNELS) {
      const mark = channelMark(c.slug);
      if (mark.kind === "glyph") continue;
      expect(mark.src, c.slug).toMatch(/^\/(logos|icons)\//);
    }
  });

  it("does not put the Google G on YouTube Ads", () => {
    const ytAds = channelMark("youtube_ads");
    const gAds = channelMark("google_ads");
    expect(ytAds).not.toEqual(gAds);
    expect(ytAds.kind === "logo" && ytAds.src).toBe("/logos/youtube-channel.svg");
  });

  it("gives a paid channel and its organic twin the same brand mark", () => {
    for (const [paid, organic] of [
      ["youtube_ads", "youtube_organic"],
      ["linkedin_ads", "linkedin_organic"],
      ["reddit_ads", "reddit_organic"],
      ["tiktok_ads", "tiktok_organic"],
      ["x_ads", "x_organic"],
    ] as const) {
      expect(channelMark(paid), paid).toEqual(channelMark(organic));
      expect(CHANNELS.find((c) => c.slug === paid)?.category).toBe("paid");
      expect(CHANNELS.find((c) => c.slug === organic)?.category).toBe("organic");
    }
  });

  it("puts the white OpenAI glyph on a dark chip", () => {
    const mark = channelMark("chatgpt_ads");
    expect(mark.bg).toBe("bg-black");
  });
});
