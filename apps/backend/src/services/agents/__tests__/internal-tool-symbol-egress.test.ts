import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import { scrubAgentEgress } from "@/services/agents/scrub-agent-egress";
import { INTERNAL_TOOL_NAMES } from "@/services/mcp/internal-tool-names";
import { internalToolEffects } from "@/services/mcp/tool-effects";
import { loadCoreInheritedBlocks } from "@/services/agents/generic-dispatcher";
import { loadChannelRecipe } from "@/services/channels/recipe";
import { buildChannelSkillBlock } from "@/services/agents/channel-skills";

const SRC = join(__dirname, "..", "..", "..");

function assembledChannelPrompt(slug: string): string {
  const recipe = loadChannelRecipe(slug);
  const parsed = matter(readFileSync(join(SRC, "agents", recipe.meta.executor, "agent.md"), "utf-8"));
  const inherits =
    (parsed.data as { metadata?: { praxis?: { inherits?: string[] } } }).metadata?.praxis?.inherits ?? [];
  return [
    loadCoreInheritedBlocks(inherits),
    parsed.content,
    buildChannelSkillBlock(recipe.meta.executor, recipe.meta.router).block,
    recipe.body,
  ].join("\n");
}

const SYMBOL = /\b[a-z][a-z0-9_]*__[a-z0-9_]+\b/i;

describe("founder-facing reply never shows a registered internal tool symbol", () => {
  it("strips the email campaigns refusal citation and the sentence still reads cleanly", () => {
    const reply = "The Newsletter list has 6 people, all can be emailed (via outbound__list_email_lists).";
    const r = scrubAgentEgress(reply, { surface: "persist", agentSlug: "email_marketing" });
    expect(r.text).not.toMatch(/__/);
    expect(r.text).not.toMatch(/\ba tool\b/);
    expect(r.text).toBe("The Newsletter list has 6 people, all can be emailed.");
    expect(r.families).toContain("impl_symbol");
  });

  it("strips a backticked mid-sentence citation of the same tool on the chat surface", () => {
    const reply = "Checked `outbound__list_email_lists`: the Newsletter list has 6 people and 0 are blocked.";
    const r = scrubAgentEgress(reply, { surface: "chat", agentSlug: "email_marketing" });
    expect(r.text).not.toMatch(/__/);
    expect(r.text).toContain("the Newsletter list has 6 people and 0 are blocked.");
  });

  it("strips every tool name any internal server actually registers", () => {
    const names = [...internalToolEffects().keys()];
    expect(names.length).toBeGreaterThan(100);
    const leaked: string[] = [];
    for (const name of names) {
      const r = scrubAgentEgress(`Your list has 6 people (via ${name}).`, { surface: "persist", agentSlug: "email_marketing" });
      if (r.text.includes("__") || r.text !== "Your list has 6 people.") leaked.push(`${name} -> ${r.text}`);
    }
    expect(leaked).toEqual([]);
  });

  it("redacts exactly the tool names the registry declares, no more and no fewer", () => {
    expect([...INTERNAL_TOOL_NAMES].sort()).toEqual([...internalToolEffects().keys()].sort());
  });

  it("keeps the user's own repo symbols, dunders and CLI commands", () => {
    const text =
      "Run `npm run db:migrate`, then check `my_module__helper__init` and Python `__init__`; the field `user__email__iexact` is yours.";
    const r = scrubAgentEgress(text, { surface: "chat", agentSlug: "engineer" });
    expect(r.text).toBe(text);
    expect(r.hits).toBe(0);
  });

  it.each([
    "Use `filter(email__iexact=x)` for a case-insensitive match.",
    "Order by `product__category__slug` first.",
    "Set seo__title and social__handle on the model.",
    "The page lives at https://x.com/a_b/email__c today.",
    "Write to bob@email__x.com for access.",
    "Your field email__send_time and email__plan_sender are yours.",
  ])("keeps customer text that only looks like a server id: %s", (text) => {
    const r = scrubAgentEgress(text, { surface: "chat", agentSlug: "engineer" });
    expect(r.text).toBe(text);
    expect(r.hits).toBe(0);
  });
});

describe("assembled email_marketing chat prompt", () => {
  const prompt = assembledChannelPrompt("email_marketing");

  it("never models a reply or citation that names a tool symbol", () => {
    const lines = prompt.split("\n");
    const citesSymbol = lines.filter(
      (l) => /\b(?:cite|citation|names?)\b/i.test(l) && /\bvia\s+`?[a-z][a-z0-9_]*__[a-z0-9_]+/i.test(l) && !l.includes("\u2717"),
    );
    expect(citesSymbol).toEqual([]);
    const sampleReplies = lines.filter((l) => /^>\s*\w+:/.test(l.trim()) && SYMBOL.test(l));
    expect(sampleReplies).toEqual([]);
  });
});
