import { describe, expect, it } from "vitest";
import { channelLookupOf } from "../channel_stats";

describe("channelLookupOf", () => {
  it("keeps a handle as a handle", () => {
    expect(channelLookupOf("@upcar")).toEqual({ forHandle: "@upcar" });
    expect(channelLookupOf("upcar")).toEqual({ forHandle: "@upcar" });
  });

  it("reads the handle out of a pasted channel URL instead of looking the URL up", () => {
    expect(channelLookupOf("https://www.youtube.com/@upcar")).toEqual({ forHandle: "@upcar" });
    expect(channelLookupOf("youtube.com/@upcar/videos?view=0")).toEqual({ forHandle: "@upcar" });
    expect(channelLookupOf("https://www.youtube.com/user/Upcar")).toEqual({ forUsername: "Upcar" });
  });

  it("refuses a video, Shorts or /c/ URL instead of guessing a handle from its path", () => {
    expect(() => channelLookupOf("https://www.youtube.com/watch?v=abc123")).toThrow(/not a channel link/);
    expect(() => channelLookupOf("https://youtube.com/shorts/abc123")).toThrow(/not a channel link/);
    expect(() => channelLookupOf("https://m.youtube.com/c/upcar")).toThrow(/not a channel link/);
  });

  it("reads a channel id out of a /channel/ URL, or takes a bare one", () => {
    expect(channelLookupOf("https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv")).toEqual({ id: "UCabcdefghijklmnopqrstuv" });
    expect(channelLookupOf("UCabcdefghijklmnopqrstuv")).toEqual({ id: "UCabcdefghijklmnopqrstuv" });
  });
});
