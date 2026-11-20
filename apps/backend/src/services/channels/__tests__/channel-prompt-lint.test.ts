
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import { loadCoreInheritedBlocks } from "@/services/agents/generic-dispatcher";
import { listRecipeSlugs, loadChannelRecipe } from "@/services/channels/recipe";
import { buildChannelSkillBlock } from "@/services/agents/channel-skills";

const SRC = join(__dirname, "..", "..", "..");
const BUDGET_PATH = join(SRC, "channels", "prompt-budget.json");

type Parts = {
  cores: number;
  agent: number;
  skills: number;
  recipe: number;
  router: number;
  total: number;
};

function measure(slug: string): Parts {
  const recipe = loadChannelRecipe(slug);
  const agentDir = join(SRC, "agents", recipe.meta.executor);
  const raw = readFileSync(join(agentDir, "agent.md"), "utf-8");
  const parsed = matter(raw);
  const inherits =
    (parsed.data as { metadata?: { praxis?: { inherits?: string[] } } }).metadata?.praxis
      ?.inherits ?? [];
  const built = buildChannelSkillBlock(recipe.meta.executor, recipe.meta.router);
  expect(built.missing, `${slug}: router binds skills that do not exist`).toEqual([]);
  const skills = built.block.length;
  const parts = {
    cores: loadCoreInheritedBlocks(inherits).length,
    agent: parsed.content.length,
    skills,
    recipe: recipe.body.length,
    router: JSON.stringify(recipe.meta.router, null, 2).length,
  };
  return {
    ...parts,
    total: parts.cores + parts.agent + parts.skills + parts.recipe + parts.router,
  };
}

const measured = Object.fromEntries(listRecipeSlugs().map((s) => [s, measure(s)]));

if (process.env.UPDATE_PROMPT_BUDGET === "1") {
  const current: Record<string, number> = existsSync(BUDGET_PATH)
    ? JSON.parse(readFileSync(BUDGET_PATH, "utf-8"))
    : {};
  const next = Object.fromEntries(
    Object.entries(measured)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([s, p]) => [s, Math.min(p.total, current[s] ?? p.total)]),
  );
  writeFileSync(BUDGET_PATH, JSON.stringify(next, null, 2) + "\n");
}

const budget: Record<string, number> = JSON.parse(readFileSync(BUDGET_PATH, "utf-8"));

describe("channel prompt budget", () => {
  for (const [slug, p] of Object.entries(measured)) {
    it(`${slug} stays within its budget`, () => {
      const cap = budget[slug];
      const detail = `${slug}: ${p.total} chars (cores ${p.cores} · agent.md ${p.agent} · skills ${p.skills} · recipe ${p.recipe} · router ${p.router}) vs budget ${cap}. Move procedural rules into a tool, or replace an existing rule instead of adding one. Raising the budget is a reviewed edit to channels/prompt-budget.json.`;
      expect(cap, `${slug} has no entry in channels/prompt-budget.json`).toBeTypeOf("number");
      expect(p.total, detail).toBeLessThanOrEqual(cap);
    });
  }
});
