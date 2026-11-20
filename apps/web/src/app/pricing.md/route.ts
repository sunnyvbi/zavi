import { NextResponse } from "next/server";
import { getLivePricing, liveTier } from "@/lib/marketing/pricing";

export async function GET() {
  const pricing = await getLivePricing();
  const starter = liveTier(pricing, "starter");
  const growth = liveTier(pricing, "growth");
  const pro = liveTier(pricing, "pro");

  const lines = [
    "# Pricing: Zavi",
    "",
    `Four self-serve plans. Credits power everything Zavi does. Every plan gets ${pricing.freeDailyCredits.toLocaleString()} credits a day; daily credits reset each day and do not roll over. Paid plans add a monthly credit pool for bigger work.`,
    "",
    "## Free: $0",
    `- ${pricing.freeDailyCredits.toLocaleString()} credits every day, no card, no sales call`,
    "- Website analysis and a 30-day growth plan, chat with Zavi's advisors, research and competitor analysis, an SEO and AI-visibility audit",
    "- Slides, PDF reports, docs, spreadsheets and clickable wireframes",
    "- Build and publish websites and apps (uses your credits)",
    "",
    `## Starter: $${starter.usd}/month`,
    `- ${starter.monthlyCredits.toLocaleString()} credits a month, plus ${pricing.freeDailyCredits.toLocaleString()} a day`,
    "- Everything in Free, plus the organic growth channels (SEO, AI answers, LinkedIn, Reddit, X, Instagram), the content and design agent, and the browser agent",
    "",
    `## Growth: $${growth.usd}/month`,
    `- ${growth.monthlyCredits.toLocaleString()} credits a month, plus ${pricing.freeDailyCredits.toLocaleString()} a day`,
    "- Everything in Starter, with 6x the monthly credits, plus the video and creator channels (creator UGC, TikTok and YouTube)",
    "",
    `## Pro: $${pro.usd}/month`,
    `- ${pro.monthlyCredits.toLocaleString()} credits a month, plus ${pricing.freeDailyCredits.toLocaleString()} a day`,
    "- Everything in Growth, plus paid ads (Google/YouTube and Meta), the engineer agent and the fundraising agent",
    "",
    "## Enterprise",
    "- Custom: more credits, invoicing, security review and an SLA. Contact sales.",
    "",
    "Live prices: https://www.zaviagent.com/pricing",
    "Get started: https://www.zaviagent.com/start",
    "",
  ];

  return new NextResponse(lines.join("\n"), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
    },
  });
}
