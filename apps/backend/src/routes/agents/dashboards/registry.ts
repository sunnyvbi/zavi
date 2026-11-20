
import type { DashboardBuilder } from "./_contract";
import { build as chatgptAds } from "./chatgpt-ads";
import { build as advisor } from "./advisor";
import { build as chiefOfStaff } from "./chief-of-staff";
import { build as contentDesign } from "./content-design";
import { build as disputeResponse } from "./dispute-response";
import { build as engineer } from "./engineer";
import { build as fundraising } from "./fundraising";
import { build as geo } from "./geo";
import { build as youtubeAds } from "@/services/agents/dashboards/youtube-ads";
import { build as googleAds } from "./google-ads";
import { build as growthLead } from "./growth-lead";
import { build as instagramOrganic } from "./instagram-organic";
import { build as linkedinAds } from "@/services/agents/dashboards/linkedin-ads-display";
import { build as linkedinOrganic } from "./linkedin-organic";
import { build as operator } from "./operator";
import { build as pm } from "./pm";
import { build as pinterestOrganic } from "./pinterest-organic";
import { build as qa } from "./qa";
import { build as research } from "./research";
import { build as redditAds } from "./reddit-ads";
import { build as xAds } from "./x-ads";
import { build as redditOrganic } from "@/services/agents/dashboards/reddit-organic";
import { build as seoGeo } from "./seo-geo";
import { build as supportLead } from "./support-lead";
import { build as tiktokAds } from "./tiktok-ads";
import { build as tiktokOrganic } from "./tiktok-organic";
import { build as xOrganic } from "./x-organic";

export const DASHBOARD_BUILDERS: Record<string, DashboardBuilder> = {
  advisor,
  chatgpt_ads: chatgptAds,
  "chief-of-staff": chiefOfStaff,
  "content-design": contentDesign,
  "content-seo": contentDesign,
  "dispute-response": disputeResponse,
  engineer,
  fundraising,
  geo,
  "growth-lead": growthLead,
  operator,
  pm,
  pinterest_organic: pinterestOrganic,
  qa,
  research,
  reddit_organic: redditOrganic,
  "seo-geo": seoGeo,
  seo: seoGeo,
  "support-lead": supportLead,
  x_organic: xOrganic,
  google_ads: googleAds,
  youtube_ads: youtubeAds,
  linkedin_organic: linkedinOrganic,
  instagram_organic: instagramOrganic,
  tiktok_ads: tiktokAds,
  linkedin_ads: linkedinAds,
  reddit_ads: redditAds,
  x_ads: xAds,
  tiktok_organic: tiktokOrganic,
};
