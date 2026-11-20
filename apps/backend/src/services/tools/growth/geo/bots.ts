
export type BotClass = "training" | "search" | "user";

export type AiBot = {
  name: string;
  owner: string;
  class: BotClass;
  obeys_robots: boolean;
  recommended: boolean;
  ua: RegExp | null;
  caveat?: string;
};

export const AI_BOTS: readonly AiBot[] = [
  { name: "GPTBot", owner: "OpenAI", class: "training", obeys_robots: true, recommended: false, ua: /\bGPTBot\b/i },
  { name: "OAI-SearchBot", owner: "OpenAI", class: "search", obeys_robots: true, recommended: true, ua: /\bOAI-SearchBot\b/i },
  {
    name: "ChatGPT-User",
    owner: "OpenAI",
    class: "user",
    obeys_robots: false,
    recommended: false,
    ua: /\bChatGPT-User\b/i,
    caveat:
      "User-triggered, and OpenAI says robots.txt rules may not apply to it. Blocking GPTBot does not stop ChatGPT citing a page while browsing — only server-side access controls do.",
  },
  { name: "ClaudeBot", owner: "Anthropic", class: "training", obeys_robots: true, recommended: false, ua: /\bClaudeBot\b/i },
  { name: "Claude-SearchBot", owner: "Anthropic", class: "search", obeys_robots: true, recommended: true, ua: /\bClaude-SearchBot\b/i },
  { name: "Claude-User", owner: "Anthropic", class: "user", obeys_robots: true, recommended: false, ua: /\bClaude-User\b/i },
  { name: "PerplexityBot", owner: "Perplexity", class: "search", obeys_robots: true, recommended: true, ua: /\bPerplexityBot\b/i },
  {
    name: "Perplexity-User",
    owner: "Perplexity",
    class: "user",
    obeys_robots: false,
    recommended: false,
    ua: /\bPerplexity-User\b/i,
    caveat: "User-triggered, and Perplexity says it generally ignores robots.txt.",
  },
  {
    name: "Bingbot",
    owner: "Microsoft",
    class: "search",
    obeys_robots: true,
    recommended: true,
    ua: /\bbingbot\b/i,
    caveat: "Bing's own crawler. Copilot answers are built on Bing's index, so blocking it also removes the site there.",
  },
  {
    name: "Google-Extended",
    owner: "Google",
    class: "training",
    obeys_robots: true,
    recommended: false,
    ua: null,
    caveat:
      "Gemini training/grounding opt-out only. Blocking it does NOT remove you from AI Overviews or AI Mode — Googlebot is the control there.",
  },
  { name: "CCBot", owner: "Common Crawl", class: "training", obeys_robots: true, recommended: false, ua: /\bCCBot\b/i },
  { name: "Bytespider", owner: "ByteDance", class: "training", obeys_robots: true, recommended: false, ua: /\bBytespider\b/i },
  { name: "meta-externalagent", owner: "Meta", class: "training", obeys_robots: true, recommended: false, ua: /\bmeta-externalagent\b/i },
];

export const CITATION_BOTS: readonly string[] = AI_BOTS.filter((b) => b.recommended).map((b) => b.name);

const BY_NAME = new Map(AI_BOTS.map((b) => [b.name.toLowerCase(), b]));

export function botByName(name: string): AiBot | null {
  return BY_NAME.get(name.toLowerCase()) ?? null;
}

export function classifyUserAgent(userAgent: string | null | undefined): AiBot | null {
  if (!userAgent) return null;
  for (const bot of AI_BOTS) {
    if (bot.ua && bot.ua.test(userAgent)) return bot;
  }
  return null;
}
