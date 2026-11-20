
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import matter from "gray-matter";

const logEventMock = vi.fn(async (_arg: unknown) => {});
vi.mock("@/services/logging/logEvent", () => ({
  logEvent: (arg: unknown) => logEventMock(arg),
}));

import {
  SKILL_REGISTRY,
  skillCorpusPath,
  SKILL_LOAD_TOOL_NAME,
  MAX_SKILL_LOADS_PER_RUN,
  skillsForAgent,
  agentHasSkills,
  buildSkillIndexBlock,
  synthesizeSkillLoadTool,
  handleSkillLoad,
  resolveSkills,
  buildAutoInjectedSkillBlock,
  __resetSkillLoadCountsForTest,
} from "../skill-runtime";
import { isSideEffectingTool, INTERNAL_SERVERS } from "@/services/mcp/tool-effect-classifier";

const MAPPED_AGENT = "growth-lead";
const UNMAPPED_AGENT = "engineer";
const GOOD_SLUG = "page-cro";

beforeEach(() => {
  __resetSkillLoadCountsForTest();
  logEventMock.mockClear();
});

describe("agent↔skill mapping + gating", () => {
  it("agentHasSkills true for a mapped agent, false for an unmapped one", () => {
    expect(agentHasSkills(MAPPED_AGENT)).toBe(true);
    expect(agentHasSkills("content-design")).toBe(true);
    expect(agentHasSkills(UNMAPPED_AGENT)).toBe(false);
    expect(agentHasSkills("")).toBe(false);
  });

  it("skillsForAgent returns only mapped skills, sorted by slug", () => {
    const slugs = skillsForAgent(MAPPED_AGENT).map((s) => s.slug);
    expect(slugs).toEqual([...slugs].sort());
    expect(slugs).toContain(GOOD_SLUG);
    expect(skillsForAgent(UNMAPPED_AGENT)).toEqual([]);
  });
});

describe("(b) index is byte-stable + cheap (KV-cache safe)", () => {
  it("buildSkillIndexBlock is a pure function of agent slug — identical across calls (2 runs, 2 tenants)", () => {
    const a1 = buildSkillIndexBlock(MAPPED_AGENT);
    const a2 = buildSkillIndexBlock(MAPPED_AGENT);
    expect(a1).toBe(a2);
    expect(a1.length).toBeGreaterThan(0);
  });

  it("index carries no volatile tokens (date / hash / uuid) and no playbook body", () => {
    const block = buildSkillIndexBlock(MAPPED_AGENT);
    expect(block).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(block).not.toMatch(/[0-9a-f]{12,}/);
    expect(block).not.toContain("Clarity over cleverness");
    expect(block).toContain(SKILL_LOAD_TOOL_NAME);
    expect(block).toContain(GOOD_SLUG);
  });

  it("empty string for an unmapped agent (byte-identical to today)", () => {
    expect(buildSkillIndexBlock(UNMAPPED_AGENT)).toBe("");
  });

  it("index is cheap — well under ~1KB for the P0 set", () => {
    expect(buildSkillIndexBlock(MAPPED_AGENT).length).toBeLessThan(1200);
  });
});

describe("(c-partial) synthesized skill__load tool shape", () => {
  it("has the canonical skill__load name + slug input schema, read-only", () => {
    const t = synthesizeSkillLoadTool();
    expect(t.name).toBe("skill__load");
    expect(t.server_id).toBe("skill");
    expect(t.tool_name).toBe("load");
    expect(t.input_schema.required).toEqual(["slug"]);
    expect(t.input_schema.properties).toHaveProperty("slug");
  });
});

describe("(a) slug allowlist rejects adversarial input", () => {
  const bad = [
    "../../etc/passwd",
    "..%2f..%2fetc%2fpasswd",
    "copywriting/../seo-audit",
    "/etc/passwd",
    "copywriting\u0000",
    "does-not-exist",
    "Copywriting",
    "copy writing",
    "",
  ];
  for (const slug of bad) {
    it(`rejects '${JSON.stringify(slug)}' with a clean error and no path echo`, async () => {
      const r = await handleSkillLoad({
        run_id: "run-a",
        agent_slug: MAPPED_AGENT,
        input: { slug },
      });
      expect(r.is_error).toBe(true);
      expect(r.content).not.toContain("/");
      expect(r.content).not.toContain("passwd");
      expect(r.content).not.toContain("etc");
    });
  }

  it("rejects a non-string / missing slug", async () => {
    for (const input of [{}, { slug: 123 }, { slug: null }, null, "raw"]) {
      const r = await handleSkillLoad({
        run_id: "run-a",
        agent_slug: MAPPED_AGENT,
        input,
      });
      expect(r.is_error).toBe(true);
    }
  });
});

describe("(f) agent↔applies_to authorization", () => {
  it("rejects a load from an agent not in the skill's applies_to", async () => {
    const r = await handleSkillLoad({
      run_id: "run-f",
      agent_slug: UNMAPPED_AGENT,
      input: { slug: GOOD_SLUG },
    });
    expect(r.is_error).toBe(true);
    expect(r.content).toContain(GOOD_SLUG);
  });

  it("rejects a load with no agent_slug", async () => {
    const r = await handleSkillLoad({
      run_id: "run-f2",
      input: { slug: GOOD_SLUG },
    });
    expect(r.is_error).toBe(true);
  });

  it("allows a mapped agent to load a mapped skill (returns the body, hash-logged)", async () => {
    const r = await handleSkillLoad({
      run_id: "run-f3",
      tenant_id: "t1",
      agent_slug: MAPPED_AGENT,
      input: { slug: GOOD_SLUG },
    });
    expect(r.is_error).toBe(false);
    expect(r.content.length).toBeGreaterThan(100);
    expect(logEventMock).toHaveBeenCalledTimes(1);
    const arg = logEventMock.mock.calls[0][0] as {
      code: string;
      meta: { slug: string; content_hash: string };
    };
    expect(arg.code).toBe("skill.load");
    expect(arg.meta.slug).toBe(GOOD_SLUG);
    expect(arg.meta.content_hash).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify(arg)).not.toContain("Clarity over cleverness");
  });
});

describe("(d) per-run load cap enforced (incl. best-of-N multiplication)", () => {
  it(`allows ${MAX_SKILL_LOADS_PER_RUN} loads then returns a synthetic cap result for the same run_id`, async () => {
    const RUN = "run-cap";
    for (let i = 0; i < MAX_SKILL_LOADS_PER_RUN; i++) {
      const r = await handleSkillLoad({
        run_id: RUN,
        agent_slug: MAPPED_AGENT,
        input: { slug: GOOD_SLUG },
      });
      expect(r.is_error).toBe(false);
      expect(r.content).not.toContain("cap reached");
    }
    const capped = await handleSkillLoad({
      run_id: RUN,
      agent_slug: MAPPED_AGENT,
      input: { slug: GOOD_SLUG },
    });
    expect(capped.is_error).toBe(true);
    expect(capped.content).toContain("cap reached");
  });

  it("the cap is run_id-scoped — a different run_id (or best-of-N candidate) starts fresh", async () => {
    for (let i = 0; i < MAX_SKILL_LOADS_PER_RUN; i++) {
      await handleSkillLoad({ run_id: "run-x", agent_slug: MAPPED_AGENT, input: { slug: GOOD_SLUG } });
    }
    const other = await handleSkillLoad({
      run_id: "run-y",
      agent_slug: MAPPED_AGENT,
      input: { slug: GOOD_SLUG },
    });
    expect(other.is_error).toBe(false);
    expect(other.content).not.toContain("cap reached");
  });

  it("a rejected load does NOT consume the cap (only successful loads count)", async () => {
    const RUN = "run-reject-nocount";
    await handleSkillLoad({ run_id: RUN, agent_slug: MAPPED_AGENT, input: { slug: "nope" } });
    await handleSkillLoad({ run_id: RUN, agent_slug: MAPPED_AGENT, input: { slug: "../x" } });
    for (let i = 0; i < MAX_SKILL_LOADS_PER_RUN; i++) {
      const r = await handleSkillLoad({ run_id: RUN, agent_slug: MAPPED_AGENT, input: { slug: GOOD_SLUG } });
      expect(r.content).not.toContain("cap reached");
    }
  });
});

describe("(e) read-only classification — no write-gate trip", () => {
  it("skill is an INTERNAL read-only server (skill__load is not side-effecting)", () => {
    expect(INTERNAL_SERVERS.has("skill")).toBe(true);
    expect(isSideEffectingTool("skill", "load")).toBe(false);
  });
});

describe("registry ↔ frontmatter drift guard", () => {
  it("every registry entry has a corpus file whose frontmatter matches (name + applies_to)", () => {
    for (const entry of SKILL_REGISTRY) {
      if (entry.agent_section) continue;
      const p = skillCorpusPath(entry);
      const parsed = matter(readFileSync(p, "utf-8"));
      const fm = parsed.data as { name?: string; applies_to?: string[]; when_to_use?: string };
      expect(fm.name, `${entry.slug} frontmatter name`).toBe(entry.slug);
      expect([...(fm.applies_to ?? [])].sort()).toEqual([...entry.applies_to].sort());
      expect(parsed.content.trim().length).toBeGreaterThan(200);
    }
  });
});

describe("(P1) resolveSkills — deterministic pre-dispatch matcher", () => {
  it("matches a PRODUCTION task to copywriting for content-design", () => {
    expect(resolveSkills("content-design", "rewrite our pricing hero copy")).toContain(
      "copywriting",
    );
    expect(resolveSkills("content-design", "write a new homepage headline")).toContain(
      "copywriting",
    );
  });

  it("matches a CRO task to page-cro and an SEO task to seo-audit", () => {
    expect(
      resolveSkills("growth-lead", "why isn't our landing page converting?"),
    ).toContain("page-cro");
    expect(resolveSkills("growth-lead", "why aren't we ranking on Google?")).toContain(
      "seo-audit",
    );
  });

  it("honors applies_to — copywriting is NOT offered to growth-lead", () => {
    expect(resolveSkills("growth-lead", "rewrite our headline")).not.toContain(
      "copywriting",
    );
  });

  it("negatives stay clean — a non-specialist task injects nothing", () => {
    expect(resolveSkills("content-design", "what's our MRR this month?")).toEqual([]);
    expect(resolveSkills("growth-lead", "summarize yesterday's runs")).toEqual([]);
  });

  it("unmapped agent + empty task → []", () => {
    expect(resolveSkills("engineer", "rewrite the copy")).toEqual([]);
    expect(resolveSkills("content-design", "")).toEqual([]);
    expect(resolveSkills("content-design", "   ")).toEqual([]);
  });

  it("caps at MAX_SKILL_LOADS_PER_RUN", () => {
    const all = resolveSkills(
      "content-design",
      "rewrite the landing page copy to convert better and fix our SEO ranking",
    );
    expect(all.length).toBeLessThanOrEqual(MAX_SKILL_LOADS_PER_RUN);
    expect(all.length).toBeGreaterThan(0);
  });
});

describe("(P1) buildAutoInjectedSkillBlock", () => {
  it("positive — injects the matched playbook body + reports the slug", () => {
    const { block, slugs } = buildAutoInjectedSkillBlock(
      "content-design",
      "rewrite our pricing hero copy",
    );
    expect(slugs).toContain("copywriting");
    expect(block).toContain("Skill playbook: copywriting");
    expect(block.length).toBeGreaterThan(200);
  });

  it("negative — no match → empty block, no slugs (byte-identical to none)", () => {
    const { block, slugs } = buildAutoInjectedSkillBlock(
      "content-design",
      "what's our MRR this month?",
    );
    expect(block).toBe("");
    expect(slugs).toEqual([]);
  });

  it("auto-injected bodies count against the SHARED per-run load cap", async () => {
    const RUN = "run-autoinject-cap";
    const { slugs } = buildAutoInjectedSkillBlock(
      "content-design",
      "rewrite our pricing hero copy",
      RUN,
    );
    expect(slugs).toEqual(["copywriting"]);
    let capped = false;
    for (let i = 0; i < MAX_SKILL_LOADS_PER_RUN; i++) {
      const r = await handleSkillLoad({
        run_id: RUN,
        agent_slug: "content-design",
        input: { slug: "copywriting" },
      });
      if (r.content.includes("cap reached")) {
        capped = true;
        expect(i).toBeLessThan(MAX_SKILL_LOADS_PER_RUN);
        break;
      }
    }
    expect(capped).toBe(true);
  });

  it("no runId → does not touch the cap (pure build, e.g. preview)", async () => {
    const RUN = "run-autoinject-norun";
    buildAutoInjectedSkillBlock("content-design", "rewrite our hero copy");
    for (let i = 0; i < MAX_SKILL_LOADS_PER_RUN; i++) {
      const r = await handleSkillLoad({
        run_id: RUN,
        agent_slug: "content-design",
        input: { slug: "copywriting" },
      });
      expect(r.content).not.toContain("cap reached");
    }
  });
})

describe("chart-design — generative-UI playbook, operator-scoped", () => {
  it("operator is a mapped agent: chart-design, extension-browser-control and its two on-demand manuals", () => {
    expect(agentHasSkills("operator")).toBe(true);
    expect(skillsForAgent("operator").map((s) => s.slug)).toEqual([
      "chart-design",
      "extension-browser-control",
      "operator-render-video",
      "operator-slack-document",
    ]);
  });

  it("matches the shapes that should become a card", () => {
    for (const task of [
      "show me spend by channel last month",
      "chart our signups over time",
      "what's the breakdown of revenue by source",
      "how did CAC trend over the last 8 weeks",
      "give me a funnel of the signup flow",
      "top 10 campaigns by spend",
      "visualize our weekly actives",
    ]) {
      expect(resolveSkills("operator", task), task).toContain("chart-design");
    }
  });

  it("negatives stay clean — operator's non-visual asks inject nothing", () => {
    for (const task of [
      "what's our MRR",
      "summarize yesterday's runs",
      "why is the deploy failing",
      "open my dashboard",
      "connect the stripe account",
      "is the funnel-diagnosis skill loaded",
    ]) {
      expect(resolveSkills("operator", task), task).toEqual([]);
    }
  });

  it("honors applies_to — a channel agent never gets it", () => {
    expect(resolveSkills("meta_ads", "show me spend by channel")).not.toContain(
      "chart-design",
    );
    expect(agentHasSkills("meta_ads")).toBe(false);
  });

  it("the body states the constraints the tools actually enforce", () => {
    const entry = SKILL_REGISTRY.find((s) => s.slug === "chart-design")!;
    const body = readFileSync(skillCorpusPath(entry), "utf8");
    expect(body).toMatch(/ONE series/);
    expect(body).toMatch(/30 points/);
    expect(body).toMatch(/≤8 items/);
    expect(body).toMatch(/≤8 columns, ≤50 rows/);
  });
});
