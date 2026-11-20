import type { BlogPost } from "./types";
import { freeWebsiteScoreChecker } from "./posts/free-website-score-checker";
import { showUpInChatgpt } from "./posts/how-to-get-my-business-to-show-up-in-chatgpt";
import { aiGrowthAgentChecklist } from "./posts/ai-growth-agent-what-to-check";
import { firstTenCustomers } from "./posts/first-10-customers-without-a-marketing-team";
import { canAiRunMyFacebookAds } from "./posts/can-ai-run-my-facebook-ads";

export type { BlogPost, BlogFaq, BlogSource } from "./types";

export const BLOG_PATH = "/blog";
export const BLOG_AUTHOR = { name: "Ravi Ramadasu", role: "Founder, Zavi" } as const;

export const BLOG_POSTS: readonly BlogPost[] = [
  canAiRunMyFacebookAds,
  freeWebsiteScoreChecker,
  showUpInChatgpt,
  aiGrowthAgentChecklist,
  firstTenCustomers,
].sort((a, b) => (a.datePublished === b.datePublished ? a.slug.localeCompare(b.slug) : a.datePublished < b.datePublished ? 1 : -1));

export const pathForPost = (slug: string) => `${BLOG_PATH}/${slug}`;

export function findPost(slug: string): BlogPost | undefined {
  return BLOG_POSTS.find((p) => p.slug === slug);
}
