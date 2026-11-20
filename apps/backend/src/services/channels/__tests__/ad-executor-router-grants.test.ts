import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { describe, expect, it } from "vitest";
import { loadChannelRecipe } from "../recipe";

const AGENTS = path.join(__dirname, "..", "..", "..", "agents");

describe.each(["chatgpt_ads", "google_ads", "meta_ads", "tiktok_ads"])("%s executor grants", (slug) => {
  const fm = matter(fs.readFileSync(path.join(AGENTS, slug, "agent.md"), "utf-8")).data as {
    metadata?: { praxis?: { tools?: string[]; tool_rationale?: Record<string, string> } };
  };
  const granted = new Set(fm.metadata?.praxis?.tools ?? []);

  it("is granted every tool a router step names", () => {
    const steps = loadChannelRecipe(slug).meta.router;
    const missing = [...new Set(steps.flatMap((s) => s.tools))].filter((t) => !granted.has(t));
    expect(missing).toEqual([]);
  });

  if (slug !== "tiktok_ads") it("reads the controls and cannot register a stop itself", () => {
    expect(granted.has("growth__read_business_controls")).toBe(true);
    expect(granted.has("growth__register_experiment")).toBe(false);
  });
});
