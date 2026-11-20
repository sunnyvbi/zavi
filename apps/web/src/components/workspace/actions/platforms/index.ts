
import { meta_ads } from "./meta_ads";
import { google_ads } from "./google_ads";
import { youtube_ads } from "./youtube_ads";
import { tiktok_ads } from "./tiktok_ads";
import { linkedin_ads } from "./linkedin_ads";
import { reddit_ads } from "./reddit_ads";
import { x_ads } from "./x_ads";
import { chatgpt_ads } from "./chatgpt_ads";
import { seo } from "./seo";
import { blog } from "./blog";
import { geo } from "./geo";
import { x_organic } from "./x_organic";
import { linkedin_organic } from "./linkedin_organic";
import { reddit_organic } from "./reddit_organic";
import { instagram_organic } from "./instagram_organic";
import { tiktok_organic } from "./tiktok_organic";
import { pinterest_organic } from "./pinterest_organic";
import { youtube_organic } from "./youtube_organic";
import { ugc } from "./ugc";
import { generated_video } from "./generated_video";
import { email_marketing } from "./email_marketing";
import { sms } from "./sms";

import type { PlatformSpec } from "./_shared";

export { xIntentUrl, redditTargetUrl, xLength } from "./_shared";

export const PLATFORMS: Record<string, PlatformSpec> = {
  meta_ads,
  google_ads,
  youtube_ads,
  tiktok_ads,
  linkedin_ads,
  reddit_ads,
  x_ads,
  chatgpt_ads,
  seo,
  blog,
  geo,
  x_organic,
  linkedin_organic,
  reddit_organic,
  instagram_organic,
  tiktok_organic,
  pinterest_organic,
  youtube_organic,
  ugc,
  generated_video,
  email_marketing,
  sms,
};

export function platformFor(slug: string): PlatformSpec {
  return PLATFORMS[slug] ?? { name: slug.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) };
}
