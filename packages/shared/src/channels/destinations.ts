import type { ActionType } from "./registry";

export type Destination = {
  name: string;
  composer: readonly ActionType[];
  publishes?: readonly ActionType[];
  adsPath?: string;
  app?: string;
};

const POSTS: readonly ActionType[] = ["text_post", "image_post", "video_post"];

export const DESTINATIONS: Readonly<Record<string, Destination>> = {
  meta_ads: { name: "Meta Ads", composer: [], adsPath: "Meta Ads Manager › Campaigns › Create" },
  google_ads: { name: "Google Ads", composer: [], adsPath: "Google Ads › Campaigns › + New campaign" },
  youtube_ads: { name: "YouTube Ads", composer: [], adsPath: "Google Ads › Campaigns › + New campaign › Video" },
  tiktok_ads: { name: "TikTok Ads", composer: [], adsPath: "TikTok Ads Manager › Campaign › Create" },
  linkedin_ads: { name: "LinkedIn Ads", composer: [], adsPath: "LinkedIn Campaign Manager › Create › Campaign" },
  reddit_ads: { name: "Reddit Ads", composer: [], adsPath: "Reddit Ads › Campaigns › Create campaign" },
  x_ads: { name: "X Ads", composer: [], adsPath: "X Ads Manager › Campaigns › Create campaign" },
  chatgpt_ads: { name: "ChatGPT Ads", composer: [], adsPath: "your ChatGPT ads account › Campaigns › New" },
  seo: { name: "Search Console", composer: [] },
  geo: { name: "your site", composer: [] },
  blog: { name: "your blog", composer: [] },
  linkedin_organic: { name: "LinkedIn", composer: POSTS },
  reddit_organic: { name: "Reddit", composer: [], publishes: [...POSTS, "reply"] },
  x_organic: { name: "X", composer: POSTS },
  instagram_organic: { name: "Instagram", composer: [], app: "the Instagram app" },
  tiktok_organic: { name: "TikTok", composer: [], app: "the TikTok app" },
  pinterest_organic: { name: "Pinterest", composer: [], app: "Pinterest" },
  ugc: { name: "UGC Videos", composer: [] },
  generated_video: { name: "AI UGC Videos", composer: [] },
  youtube_organic: { name: "YouTube", composer: [], app: "YouTube Studio" },
  email_marketing: { name: "your email tool", composer: [] },
  sms: { name: "your SMS tool", composer: [] },
};

export function destinationFor(slug: string): Destination {
  return (
    DESTINATIONS[slug] ?? {
      name: slug.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      composer: [],
    }
  );
}
