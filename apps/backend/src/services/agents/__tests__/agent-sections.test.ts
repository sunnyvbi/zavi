import { readFileSync } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { describe, expect, it } from "vitest";
import { splitAgentSection } from "../agent-sections";
import { SKILL_REGISTRY, buildSkillIndexBlock, skillsForAgent } from "../skill-runtime";
import { normalizeToolName } from "../sdk/mcp-server-tools";
import { VariantConfigSchema } from "../engine/variant-config";

const V1_SKILLS = ["operator-render-video", "operator-slack-document"];
const operatorMd = matter(
  readFileSync(path.join(process.cwd(), "src", "agents", "operator", "agent.md"), "utf-8"),
);
const operatorBody = operatorMd.content;
const operatorMeta = (operatorMd.data as { metadata?: { praxis?: Record<string, unknown> } })
  .metadata!.praxis!;

type SeededConfig = { tools?: { always_load?: string[] } };
function seededConfigs(): SeededConfig[] {
  const sql = readFileSync(
    path.join(process.cwd(), "..", "..", "supabase", "migrations", "20260921193000_agent_engine_variants.sql"),
    "utf-8",
  );
  return [...sql.matchAll(/^\s+'(\{.*\})',$/gm)].map((m) => JSON.parse(m[1]) as SeededConfig);
}

describe("splitAgentSection", () => {
  it("cuts one section and keeps ### subsections inside it", () => {
    const r = splitAgentSection("## A\na\n## B — x\nb\n### B.1\nb1\n## C\nc", "B");
    expect(r).toEqual({ section: "## B — x\nb\n### B.1\nb1", rest: "## A\na\n## C\nc" });
  });

  it("returns null for a heading that is not there", () => {
    expect(splitAgentSection("## A\na", "Z")).toBeNull();
  });
});

describe("v1 operator prompt move", () => {
  const entries = SKILL_REGISTRY.filter((s) => V1_SKILLS.includes(s.slug));

  it("every moved section still exists in operator/agent.md, and no line is lost", () => {
    expect(entries).toHaveLength(2);
    for (const e of entries) {
      const cut = splitAgentSection(operatorBody, e.agent_section!);
      expect(cut, `heading "## ${e.agent_section}" not found`).not.toBeNull();
      expect(cut!.section.length).toBeGreaterThan(5_000);
      const lines = (s: string) => s.split("\n").filter((l) => l.trim()).sort();
      expect(lines(cut!.section + "\n" + cut!.rest)).toEqual(lines(operatorBody));
    }
  });

  it("offers both manuals to every operator run (default since the lean operator prompt)", () => {
    expect(skillsForAgent("operator").map((s) => s.slug)).toEqual([
      "chart-design",
      "extension-browser-control",
      "operator-render-video",
      "operator-slack-document",
    ]);
    for (const s of V1_SKILLS) expect(buildSkillIndexBlock("operator")).toContain(s);
  });

  it("with both manuals cut, the always-on operator body is the lean prompt (under 25K chars)", () => {
    let body = operatorBody;
    for (const s of skillsForAgent("operator")) {
      if (!s.agent_section) continue;
      const cut = splitAgentSection(body, s.agent_section);
      expect(cut, s.slug).not.toBeNull();
      body = cut!.rest;
    }
    expect(body.length).toBeLessThan(25_000);
  });

  it("removes at least a quarter of the operator prompt body", () => {
    let body = operatorBody;
    for (const e of entries) body = splitAgentSection(body, e.agent_section!)!.rest;
    expect(body.length / operatorBody.length).toBeLessThan(0.75);
  });

  it("every seeded variant config passes the schema", () => {
    expect(seededConfigs().length).toBeGreaterThanOrEqual(5);
    for (const c of seededConfigs()) expect(VariantConfigSchema.safeParse(c).success).toBe(true);
  });
});

describe("v2 always_load tool names", () => {
  it("every always_load name is a tool operator can actually call", () => {
    const declared = new Set(
      (operatorMeta.tools as string[]).filter((t) => !t.includes("*")).map(normalizeToolName),
    );
    const alwaysOnServers = new Set(
      [...readFileSync(path.join(process.cwd(), "src", "services", "mcp", "discovery.ts"), "utf-8")
        .matchAll(/tenant_id:\s*"\*",\s*server_id:\s*"([a-z0-9_]+)"/g)].map((m) => m[1]),
    );
    expect(alwaysOnServers.has("praxis_corpus")).toBe(true);
    const names = seededConfigs().flatMap((c) => c.tools?.always_load ?? []);
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) {
      const ok =
        declared.has(normalizeToolName(n)) ||
        alwaysOnServers.has(n.replace(/^mcp__server__/, "").split("__")[0]);
      expect(ok, `${n} is neither declared by operator nor on an always-on server`).toBe(true);
    }
  });

  it("normalizeToolName accepts either spelling and the SDK's prefixed form", () => {
    for (const v of ["memory__search", "memory_search", "mcp__server__memory__search", "MEMORY__SEARCH"]) {
      expect(normalizeToolName(v)).toBe("memory_search");
    }
  });
});
