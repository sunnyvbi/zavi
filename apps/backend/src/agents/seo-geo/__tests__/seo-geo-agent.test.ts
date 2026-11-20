
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import matter from "gray-matter";

import { outputSchemas } from "@/agents/index";
import { SEO_GEO_DISPATCH_ALLOWLIST } from "@/agents/seo-geo/output-schema";
import { skillsForAgent, resolveSkills } from "@/services/agents/skill-runtime";
import { isArtifactProducer } from "@/services/agents/slack-fresh-work-gate";

const AGENT_MD = path.join(process.cwd(), "src", "agents", "seo-geo", "agent.md");
const praxis = (() => {
  const fm = matter(readFileSync(AGENT_MD, "utf-8")).data as Record<string, unknown>;
  return ((fm.metadata as Record<string, unknown>).praxis ?? {}) as Record<string, unknown>;
})();

function envelope(over: Record<string, unknown> = {}) {
  return {
    diagnosis: { stage: "growth", goal_restated: "Audit example.com", key_signals: [] },
    research_findings: [],
    recommendations: { decide_today: [], next_30d: [], watch_for: [], deprioritize: [] },
    dispatch_proposals: [],
    clarifications_needed: false,
    rendered_markdown: "# Audit",
    ...over,
  };
}

const proposal = (agent_slug: string) => ({
  agent_slug,
  brief: "context: x; target_output: y; constraints: draft only",
  why: "because",
});

describe("seo-geo — frontmatter contract", () => {
  it("is RETIRED (2026-09-06) in favour of the `seo` channel specialist", () => {
    expect((praxis.visibility as Record<string, unknown>).default_state).toBe("disabled");
  });

  it("allows manual runs (manual_only:true is the ALLOW flag, per runner.ts)", () => {
    expect(praxis.manual_only).toBe(true);
  });

  it("takes no side effects and schedules no cron", () => {
    expect(praxis.side_effects).toBe(false);
    expect(praxis.cron).toBe("");
  });

  it("declares the full READ_BASELINE plus the web tools it actually runs on", () => {
    const tools = praxis.tools as string[];
    for (const t of ["web_search__search", "web_fetch__fetch", "apify__rag_web_browser"]) {
      expect(tools, `${t} must be declared`).toContain(t);
    }
  });

  it("holds NO write tool beyond memory__write, and no browser_* tool", () => {
    const tools = praxis.tools as string[];
    expect(tools.filter((t) => t.startsWith("browser_"))).toEqual([]);
    expect(tools.filter((t) => t.startsWith("operator_db__"))).toEqual([]);
    expect(tools).toContain("memory__write");
    expect(tools).not.toContain("github__open_pr");
  });

  it("counts as an artifact producer (it renders an audit PDF)", () => {
    expect(isArtifactProducer("seo-geo")).toBe(true);
  });
});

describe("seo-geo — dispatch allowlist (untrusted-input blast radius)", () => {
  it("registers a schema at all — without it there is ZERO validation", () => {
    expect(outputSchemas["seo-geo"]).toBeDefined();
  });

  it("accepts the proposal-only targets it is meant to route to", () => {
    for (const slug of SEO_GEO_DISPATCH_ALLOWLIST) {
      const r = outputSchemas["seo-geo"].safeParse(
        envelope({ dispatch_proposals: [proposal(slug)] }),
      );
      expect(r.success, `${slug} should be allowed`).toBe(true);
    }
  });

  it("REJECTS engineer — the code-writing agent is never a legal target", () => {
    const r = outputSchemas["seo-geo"].safeParse(
      envelope({ dispatch_proposals: [proposal("engineer")] }),
    );
    expect(r.success).toBe(false);
  });

  it("rejects any agent outside the allowlist, including a plausible one", () => {
    for (const slug of ["performance-marketer", "operator", "pm", "not-an-agent"]) {
      const r = outputSchemas["seo-geo"].safeParse(
        envelope({ dispatch_proposals: [proposal(slug)] }),
      );
      expect(r.success, `${slug} must be rejected`).toBe(false);
    }
  });

  it("does not widen advisor's allowlist as a side effect of sharing the schema", () => {
    const r = outputSchemas.advisor.safeParse(
      envelope({ dispatch_proposals: [proposal("content-design")] }),
    );
    expect(r.success).toBe(false);
  });
});

describe("seo-geo — playbook access", () => {
  it("can see every SEO/GEO playbook", () => {
    const mine = skillsForAgent("seo-geo").map((s) => s.slug);
    for (const slug of [
      "geo-audit",
      "seo-audit",
      "seo-content",
      "seo-content-brief",
      "seo-page",
      "seo-schema",
      "seo-technical",
    ]) {
      expect(mine, `${slug} must be available to seo-geo`).toContain(slug);
    }
  });

  it("routes real asks to the right playbook", () => {
    expect(resolveSkills("seo-geo", "why aren't we cited in AI Overviews?")).toContain(
      "geo-audit",
    );
    expect(resolveSkills("seo-geo", "robots.txt is blocking our sitemap")).toContain(
      "seo-technical",
    );
    expect(resolveSkills("seo-geo", "validate our JSON-LD")).toContain("seo-schema");
  });

  it("negatives stay clean", () => {
    expect(resolveSkills("seo-geo", "what's our MRR this month?")).toEqual([]);
  });
});
