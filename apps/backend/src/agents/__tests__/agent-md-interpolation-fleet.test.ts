import { readdirSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

import matter from "gray-matter";
import { describe, expect, it } from "vitest";

import { interpolate } from "../../services/agents/template";

const AGENTS_DIR = path.join(__dirname, "..");

const RENDER_CTX = {
  tenant: { display_name: "Acme", slug: "acme" },
  memory: {
    company: "(company memory)",
    ops: "(ops memory)",
    policies: "(policies memory)",
    disputes: "(disputes memory)",
    support: "(support memory)",
  },
};

const ALLOWED_TOKENS = new Set([
  "{{ memory.company }}",
  "{{ memory.ops }}",
  "{{ memory.policies }}",
  "{{ memory.disputes }}",
  "{{ memory.support }}",
]);

function agentSlugs(): string[] {
  return readdirSync(AGENTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((n) => existsSync(path.join(AGENTS_DIR, n, "agent.md")))
    .sort();
}

function loadBody(slug: string): string {
  return matter(readFileSync(path.join(AGENTS_DIR, slug, "agent.md"), "utf-8")).content;
}

describe("agent.md fleet — interpolation safety", () => {
  const slugs = agentSlugs();

  it("discovers the agent templates (guards against a silently-empty suite)", () => {
    expect(slugs.length).toBeGreaterThan(5);
  });

  it.each(slugs)("%s: body renders without an unresolved placeholder", (slug) => {
    expect(() => interpolate(loadBody(slug), RENDER_CTX)).not.toThrow();
  });

  it.each(slugs)("%s: contains only canonical memory tokens", (slug) => {
    const found = loadBody(slug).match(/\{\{[^}]*\}\}/g) ?? [];
    const illegal = found.filter((t) => !ALLOWED_TOKENS.has(t));
    expect(illegal).toEqual([]);
  });
});

describe("agent.md fleet — company-brain coverage (2026-07-16)", () => {
  it.each(["operator", "research", "qa", "browser-operator"])(
    "%s reads the company brain",
    (slug) => {
      expect(loadBody(slug)).toContain("{{ memory.company }}");
    },
  );
});
