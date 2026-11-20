
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import matter from "gray-matter";

import {
  SKILL_REGISTRY,
  skillCorpusPath,
  skillsForAgent,
  resolveSkills,
  MAX_SKILL_LOADS_PER_RUN,
} from "@/services/agents/skill-runtime";
import { listSkillNames } from "@/services/agents/deepagent/skills";

const SEO_GEO_SLUGS = [
  "geo-audit",
  "seo-content",
  "seo-content-brief",
  "seo-page",
  "seo-schema",
  "seo-technical",
] as const;

const MAX_SKILL_BODY_BYTES = 12_000;

function bodyOf(slug: string): string {
  const entry = SKILL_REGISTRY.find((s) => s.slug === slug);
  expect(entry, `${slug} must be in SKILL_REGISTRY`).toBeDefined();
  return matter(readFileSync(skillCorpusPath(entry!), "utf-8")).content.trim();
}

describe("SEO/GEO corpus — registry resolves to real files", () => {
  it("every registry entry resolves to a file that exists", () => {
    const missing = SKILL_REGISTRY.filter((e) => !existsSync(skillCorpusPath(e))).map(
      (e) => `${e.slug} -> ${skillCorpusPath(e)}`,
    );
    expect(missing).toEqual([]);
  });

  it("all six SEO/GEO playbooks are registered and sourced from apps/backend/skills", () => {
    for (const slug of SEO_GEO_SLUGS) {
      const entry = SKILL_REGISTRY.find((s) => s.slug === slug);
      expect(entry, `${slug} missing from SKILL_REGISTRY`).toBeDefined();
      expect(entry!.source, `${slug} source`).toBe("playbooks");
      expect(skillCorpusPath(entry!)).toContain(`/skills/${slug}/SKILL.md`);
    }
  });

  it("the Deep Agents loader sees the same six playbooks", () => {
    const names = listSkillNames();
    for (const slug of SEO_GEO_SLUGS) expect(names).toContain(slug);
  });
});

describe("SEO/GEO corpus — bodies fit the loader's clamp", () => {
  it("every registry body is non-trivial and under the truncation clamp", () => {
    const oversized: string[] = [];
    for (const entry of SKILL_REGISTRY) {
      if (entry.agent_section) continue;
      const body = bodyOf(entry.slug);
      expect(body.length, `${entry.slug} body`).toBeGreaterThan(200);
      const bytes = Buffer.byteLength(body, "utf-8");
      if (bytes > MAX_SKILL_BODY_BYTES) oversized.push(`${entry.slug}=${bytes}B`);
    }
    expect(oversized).toEqual([]);
  });

  it("every SEO/GEO playbook states its own reachability limits", () => {
    for (const slug of SEO_GEO_SLUGS) {
      expect(bodyOf(slug), `${slug} must carry a reachability section`).toContain(
        "What is actually reachable",
      );
    }
  });
});

describe("SEO/GEO corpus — cross-references resolve", () => {
  it("every /skills/... and references/... pointer names a file that exists", () => {
    const root = path.join(process.cwd(), "skills");
    const broken: string[] = [];
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? walk(path.join(dir, e.name))
          : e.name.endsWith(".md")
            ? [path.join(dir, e.name)]
            : [],
      );
    for (const file of walk(root)) {
      const txt = readFileSync(file, "utf-8");
      for (const m of txt.matchAll(/\/skills\/([A-Za-z0-9_\-/.]+\.(?:md|json))/g)) {
        if (!existsSync(path.join(root, m[1]))) broken.push(`${file} -> /skills/${m[1]}`);
      }
      for (const m of txt.matchAll(/`references\/([A-Za-z0-9_\-.]+\.(?:md|json))`/g)) {
        if (!existsSync(path.join(path.dirname(file), "references", m[1])))
          broken.push(`${file} -> references/${m[1]}`);
      }
    }
    expect(broken).toEqual([]);
  });
});

describe("SEO/GEO corpus — routing", () => {
  it("routes an AI-search question to geo-audit ahead of the generalist", () => {
    const slugs = resolveSkills(
      "growth-lead",
      "why aren't we showing up in AI Overviews and our rankings dropped",
    );
    expect(slugs[0]).toBe("geo-audit");
    expect(slugs).toContain("seo-audit");
  });

  it("priority — the specific playbooks win the cap, the generalist is dropped", () => {
    const slugs = resolveSkills(
      "growth-lead",
      "our landing page isn't converting, the title tags are wrong, crawl errors " +
        "everywhere, and we're invisible in AI Overviews — our SEO is broken",
    );
    expect(slugs).toHaveLength(MAX_SKILL_LOADS_PER_RUN);
    expect(slugs).toEqual(["geo-audit", "seo-technical", "seo-page"]);
    expect(slugs).not.toContain("seo-audit");
  });

  it("respects applies_to — seo-technical is growth-lead only", () => {
    expect(resolveSkills("growth-lead", "robots.txt is blocking our sitemap")).toContain(
      "seo-technical",
    );
    expect(skillsForAgent("content-design").map((s) => s.slug)).not.toContain(
      "seo-technical",
    );
  });

  it("routes each specific ask to its own playbook", () => {
    const cases: Array<[string, string, string]> = [
      ["content-design", "generate a content brief for our pricing page", "seo-content-brief"],
      ["content-design", "is this thin content? check the E-E-A-T signals", "seo-content"],
      ["content-design", "validate our JSON-LD structured data", "seo-schema"],
      ["growth-lead", "check this page: https://example.com/pricing", "seo-page"],
      ["growth-lead", "are we blocking PerplexityBot?", "geo-audit"],
    ];
    for (const [agent, task, expected] of cases) {
      expect(resolveSkills(agent, task), `${agent} :: ${task}`).toContain(expected);
    }
  });

  it("negatives stay clean — no SEO playbook leaks into unrelated work", () => {
    expect(resolveSkills("growth-lead", "what's our MRR this month?")).toEqual([]);
    expect(
      resolveSkills("growth-lead", "break down completed bookings per geo this week"),
    ).toEqual([]);
    expect(
      resolveSkills("growth-lead", "post https://example.com to the team channel"),
    ).toEqual([]);
  });
});
