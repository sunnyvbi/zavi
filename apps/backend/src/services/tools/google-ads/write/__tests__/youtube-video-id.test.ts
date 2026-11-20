
import { describe, it, expect } from "vitest";
import {
  isYoutubeVideoId,
  videoFormatForAdGroupType,
  youtubeVideoIdFrom,
} from "../_video-formats";

const ID = "dQw4w9WgXcQ";

describe("youtubeVideoIdFrom", () => {
  it("takes a bare id unchanged", () => {
    expect(youtubeVideoIdFrom(ID)).toBe(ID);
    expect(youtubeVideoIdFrom(`  ${ID}  `)).toBe(ID);
  });

  it("pulls the canonical id out of the URL shapes people actually paste", () => {
    const urls = [
      `https://www.youtube.com/watch?v=${ID}`,
      `https://www.youtube.com/watch?v=${ID}&list=PL123&index=2&t=31s`,
      `https://youtu.be/${ID}`,
      `https://youtu.be/${ID}?t=42`,
      `https://www.youtube.com/shorts/${ID}`,
      `https://www.youtube.com/embed/${ID}`,
      `https://www.youtube.com/live/${ID}`,
      `https://m.youtube.com/watch?v=${ID}`,
      `https://www.youtube-nocookie.com/embed/${ID}`,
      `youtube.com/watch?v=${ID}`,
      `http://youtu.be/${ID}`,
    ];
    for (const url of urls) {
      expect(youtubeVideoIdFrom(url), url).toBe(ID);
    }
  });

  it("refuses anything that is not an 11-character YouTube id", () => {
    const bad = [
      "",
      "   ",
      "not a video",
      "dQw4w9WgXc",
      "dQw4w9WgXcQQ",
      "dQw4w9WgXc!",
      "https://vimeo.com/123456789",
      `https://youtube.com.evil.example/watch?v=${ID}`,
      "https://www.youtube.com/@somechannel",
      "https://www.youtube.com/watch?v=tooshort",
    ];
    for (const input of bad) {
      expect(youtubeVideoIdFrom(input), input).toBeNull();
    }
  });

  it("settles every candidate with the SAME predicate the ad proposers use", () => {
    const extracted = youtubeVideoIdFrom(`https://www.youtube.com/watch?v=${ID}`);
    expect(extracted).not.toBeNull();
    expect(isYoutubeVideoId(extracted as string)).toBe(true);
  });
});

describe("videoFormatForAdGroupType", () => {
  it("maps each video ad-group type to the format that fits it", () => {
    expect(videoFormatForAdGroupType("VIDEO_TRUE_VIEW_IN_STREAM")).toBe("in_stream_skippable");
    expect(videoFormatForAdGroupType("VIDEO_NON_SKIPPABLE_IN_STREAM")).toBe("in_stream_non_skippable");
    expect(videoFormatForAdGroupType("VIDEO_BUMPER")).toBe("bumper");
    expect(videoFormatForAdGroupType("VIDEO_TRUE_VIEW_IN_DISPLAY")).toBe("in_feed");
    expect(videoFormatForAdGroupType("VIDEO_RESPONSIVE")).toBe("responsive");
  });

  it("returns null for a type no format maps onto, so the caller refuses it", () => {
    expect(videoFormatForAdGroupType("VIDEO_EFFICIENT_REACH")).toBeNull();
    expect(videoFormatForAdGroupType("SEARCH_STANDARD")).toBeNull();
  });
});
