
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";

const AGENTS_ROOT = path.join(process.cwd(), "src", "agents");

const TENANT_CONNECTOR_PREFIXES = [
  "meta_ads", "google_ads", "stripe", "slack", "github", "jira", "linear",
  "operator_db", "email", "posthog", "google_analytics", "tiktok_ads",
  "linkedin_ads", "reddit_ads", "youtube", "instagram",
];

function frontmatter(slug: string): Record<string, unknown> {
  const raw = fs.readFileSync(path.join(AGENTS_ROOT, slug, "agent.md"), "utf-8");
  return (matter(raw).data as { metadata?: { praxis?: Record<string, unknown> } })
    ?.metadata?.praxis ?? {};
}

describe("operator — the front door answers with nothing connected", () => {
  it("lists every tenant connector it holds tools for as OPTIONAL", () => {
    const praxis = frontmatter("operator");
    const tools = (praxis.tools ?? []) as string[];
    const optional = new Set(
      (((praxis.setup ?? {}) as { optional_connectors?: string[] }).optional_connectors ?? []),
    );

    const held = new Set(
      tools
        .map((t) => String(t).split("__")[0])
        .filter((ns) => TENANT_CONNECTOR_PREFIXES.includes(ns)),
    );
    const required = [...held].filter((ns) => !optional.has(ns)).sort();

    expect(
      required,
      `operator holds tools for ${required.join(", ")} but does not list them under ` +
        `setup.optional_connectors, which makes them REQUIRED. A tenant without them ` +
        `gets "Setup needed before I can run." instead of an answer — from the agent ` +
        `Slack routes to. Add them to optional_connectors.`,
    ).toEqual([]);
  });
});
