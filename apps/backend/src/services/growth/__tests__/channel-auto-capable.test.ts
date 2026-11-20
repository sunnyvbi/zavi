import { expect, it } from "vitest";
import { channelAutoCapable } from "../channel-auto-capable";

it("ChatGPT Ads has a CGO starter; execution still requires explicit paid consent", () => {
  expect(channelAutoCapable("chatgpt_ads")).toBe(true);
});

it("a retired channel cannot promise a loop", () => {
  expect(channelAutoCapable("blog")).toBe(false);
});

it("positive controls: the CGO's ad channels and an organic target", () => {
  for (const slug of ["google_ads", "meta_ads", "reddit_ads", "x_ads", "tiktok_ads", "linkedin_ads", "seo"]) {
    expect(channelAutoCapable(slug), slug).toBe(true);
  }
});

it("a CGO organic target counts even when its recipe is on_demand", () => {
  return import("../goal-owner").then(({ CGO_ORGANIC_TARGETS }) => {
    for (const slug of ["tiktok_organic", "ugc", "generated_video", "sms"]) {
      expect(channelAutoCapable(slug), slug).toBe(CGO_ORGANIC_TARGETS.has(slug));
    }
  });
});

it("a retired channel claims nothing: cgo never starts it", () => {
  expect(channelAutoCapable("blog")).toBe(false);
});

it("an unknown slug claims nothing", () => {
  expect(channelAutoCapable("not_a_channel")).toBe(false);
});
