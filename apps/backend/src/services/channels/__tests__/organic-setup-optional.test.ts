
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import matter from "gray-matter";

const CONNECTOR_PREFIXES = ["google_analytics", "google_search_console"];

function frontmatter(slug: string) {
  const raw = readFileSync(path.join(process.cwd(), "src", "agents", slug, "agent.md"), "utf-8");
  const praxis = (matter(raw).data as { metadata?: { praxis?: Record<string, unknown> } }).metadata
    ?.praxis ?? {};
  const tools = (praxis.tools as string[] | undefined) ?? [];
  const setup = (praxis.setup as { connectors?: string[]; optional_connectors?: string[] }) ?? {};
  return { tools, setup };
}

describe.each(["seo", "geo"])("%s runs with no connected account", (slug) => {
  it("every connector its tools derive is optional, and none is explicitly required", () => {
    const { tools, setup } = frontmatter(slug);
    const derived = CONNECTOR_PREFIXES.filter((c) => tools.some((t) => t.startsWith(`${c}__`)));
    const optional = new Set(setup.optional_connectors ?? []);
    expect(derived.filter((c) => !optional.has(c))).toEqual([]);
    expect(setup.connectors ?? []).toEqual([]);
  });
});
