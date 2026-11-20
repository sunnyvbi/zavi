import { describe, it, expect } from "vitest";
import { AI_BOTS, CITATION_BOTS, botByName, classifyUserAgent } from "../bots";
import { AI_CRAWLERS } from "../analyze";

describe("AI_BOTS", () => {
  it("gates on the doc's citation class — search bots, not training bots", () => {
    expect([...CITATION_BOTS].sort()).toEqual(["Bingbot", "Claude-SearchBot", "OAI-SearchBot", "PerplexityBot"]);
    for (const training of ["GPTBot", "ClaudeBot", "CCBot", "Google-Extended"]) {
      expect(botByName(training)!.recommended).toBe(false);
      expect(botByName(training)!.class).toBe("training");
    }
  });

  it("is the same table the robots.txt reader uses", () => {
    expect(AI_CRAWLERS.map((c) => c.name)).toEqual(AI_BOTS.map((b) => b.name));
  });

  it("has unique names", () => {
    const names = AI_BOTS.map((b) => b.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("classifyUserAgent", () => {
  const cases: Array<[string, string | null]> = [
    ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot", "OAI-SearchBot"],
    ["Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)", "GPTBot"],
    ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ChatGPT-User/1.0; +https://openai.com/bot", "ChatGPT-User"],
    ["Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)", "ClaudeBot"],
    ["Mozilla/5.0 (compatible; Claude-SearchBot/1.0; +https://www.anthropic.com)", "Claude-SearchBot"],
    ["Mozilla/5.0 (compatible; Claude-User/1.0)", "Claude-User"],
    ["Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)", "PerplexityBot"],
    ["Mozilla/5.0 (compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)", "Perplexity-User"],
    ["Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)", "Bingbot"],
    ["meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)", "meta-externalagent"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15", null],
    ["Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", null],
  ];
  it.each(cases)("%s → %s", (ua, expected) => {
    expect(classifyUserAgent(ua)?.name ?? null).toBe(expected);
  });

  it("never matches Google-Extended, which is a robots.txt token and not a crawler", () => {
    expect(classifyUserAgent("Google-Extended")).toBeNull();
  });

  it("returns null for an empty User-Agent", () => {
    expect(classifyUserAgent("")).toBeNull();
    expect(classifyUserAgent(null)).toBeNull();
  });
});
