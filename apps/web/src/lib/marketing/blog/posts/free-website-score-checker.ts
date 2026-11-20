import type { BlogPost } from "../types";

export const freeWebsiteScoreChecker: BlogPost = {
  slug: "free-website-score-checker",
  query: "website score checker free",
  title: "Free website score checker: what the 5 checks actually measure",
  description:
    "A free website score should tell you why customers are not finding you, not just how fast the page loads. Here is exactly what each of Zavi's five checks measures and how it is scored.",
  h1: "Free website score checker: what the 5 checks actually measure",
  datePublished: "2026-10-12",
  dateModified: "2026-10-12",
  reviewedAt: "2026-10-12",
  answer:
    "Zavi's free growth score checks five things that decide whether a customer finds you: where you rank on Google for a buying search, whether ChatGPT, Gemini, Perplexity and Claude name you, your SEO basics, your design on a phone, and how you compare with up to three competitors. Each check is worth 20 points, and a check that cannot be measured is left out of the total instead of counted as zero.",
  body: `Most "website score" tools grade one thing: page speed. Speed matters, but a fast site nobody can find still gets no customers. The growth score asks a wider question: **if someone is looking for what you sell, do they end up on your site?**

You paste your website on [zaviagent.com/start](/start), sign in with Google, and the card fills in over about two minutes. Here is what each part does, exactly as it is scored.

## 1. Found on Google (20 points)

The check looks for one buying search for your business, the kind of thing a customer types right before they buy. If your site already ranks in the top 20 for a relevant buying search, it uses that search and its rank. If not, it checks the broad search for your category, from your country, in Google's results down to position 100.

| Your position | Points |
| --- | --- |
| 1 to 3 | 20 |
| 4 to 10 | 15 |
| 11 to 20 | 10 |
| 21 to 100 | 4 |
| Not in the results we fetched | 0 |

Only your own domain counts. A review site's page about you does not. If Google returns fewer results than that, the card says how many it checked instead of claiming the top 100.

## 2. Shows up in AI answers (20 points)

More buyers now ask an assistant instead of searching. The check asks one buyer question for your category, once each, of **ChatGPT, Gemini, Perplexity and Claude**, from your country. The score is the share of the assistants that answered which named you, times 20: all four answer and two name you is 10 points; three answer and one names you is 7. An assistant that fails to answer is left out rather than counted against you.

## 3. SEO and site basics (20 points)

The checklist search engines expect:

- A home page title of 10 to 65 characters: 4 points
- A meta description of 50 to 160 characters: 4 points
- Exactly one main heading (H1): 3 points
- Structured data (schema) present: 3 points
- Crawlers not blocked, and a sitemap found: 3 points
- No broken pages of your own among the pages we opened (up to 6): 3 points

## 4. Design and UX (20 points)

Half comes from Google's PageSpeed test, in bands:

- Performance 90 or more: 6 points; 50 to 89: 3 points
- Accessibility 90 or more: 4 points; 70 to 89: 2 points

The other half comes from loading your site at phone size:

- A clear action visible without scrolling: 4 points. For example a button or link to buy, book, sign up, start a free trial, get a demo, get a quote or contact you, or a visible phone or email link; the check also recognizes a set of common buying words in German and French. A vague "Learn more" does not count.
- Body text at least 14 pixels: 2 points
- No boxes overlap: 2 points
- Nothing scrolls sideways: 2 points

If one half cannot be measured at all (say the PageSpeed test times out), the other half is doubled to make the 20. A PageSpeed result that comes back low still scores low.

## 5. Versus your competitors (20 points)

The card finds **up to three** competitors with their own websites and ranks you against them **like for like**: only the checks measured for you and for every competitor being compared are added up. Competitors get a lighter version of some checks: their design score comes from the phone test alone and their SEO from their home page. First place gets 20 points, last gets 0, and ties share the better rank.

## What you get besides the number

The score is not the point. Under it, the card names your **#1 growth constraint**, the one thing most likely holding back customers, and one action to take this week. The same evidence always gives the same score, so you can fix something and check again.

## When a check cannot be measured

Some sites block automated visits, and outside services sometimes fail. A check that cannot be measured is left out of your total, and the score is shown out of the checks that ran (for example 52 out of 80), never as a zero.

## What it does not do

It does not log in to your analytics, read your sales, or change anything on your site. It reads what any visitor, search engine or AI assistant can see. If you want the work done after that, that is what Zavi itself is for, and by default it asks before it publishes or spends anything.`,

  faq: [
    {
      q: "Is the website score checker really free?",
      a: "Yes. You paste a website, sign in with Google and get the card, with no credit card. Running the work that fixes what it finds is Zavi itself, which starts free.",
    },
    {
      q: "Why did one of my checks say it could not be measured?",
      a: "Some sites block automated visits, and outside services sometimes fail. A check that cannot be measured is left out of your total, so the score is shown out of the checks that ran instead of counting that check as zero.",
    },
    {
      q: "Which country are the Google and AI checks run from?",
      a: "From your business's own country when the card can tell it, among the eleven it supports. Otherwise from the United States, and the card says so.",
    },
    {
      q: "Will the score change if I run it again?",
      a: "Not on its own. The same evidence always gives the same score. It changes when something it measures changes, such as your Google position or a fix on your site.",
    },
  ],
  sources: [
    { label: "Get your free growth score (zaviagent.com/start)", url: "/start" },
    { label: "Google PageSpeed Insights", url: "https://pagespeed.web.dev/" },
  ],
  cta: { label: "Get your free growth score", href: "/start", text: "Paste your website and see all five checks for your own site in about two minutes. Free. Sign in with Google to see it." },
};
