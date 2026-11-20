
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const agentMd = (slug: string) =>
  readFileSync(join(__dirname, "..", "..", "..", "..", "agents", slug, "agent.md"), "utf8");

const HEADING = "## Operator DB — list first, then expand";
const BARE_QUERY_AGENTS = ["operator", "support-lead", "pm", "dispute-response"];
const ALL = [...BARE_QUERY_AGENTS, "chief-of-staff"];

function declaredTools(md: string): string[] {
  return [...md.matchAll(/^\s+-\s+(operator_db__[a-z_]+)\s*$/gm)].map((m) => m[1]);
}

describe("operator-DB hint is present on every catalog-bearing agent", () => {
  it.each(ALL)("%s has the section", (slug) => {
    expect(agentMd(slug)).toContain(HEADING);
  });

  it.each(ALL)("%s explains the tables:[...] expansion", (slug) => {
    expect(agentMd(slug)).toContain("tables:[...]");
  });

  it.each(ALL)("%s is told a listed collection exists", (slug) => {
    expect(agentMd(slug)).toMatch(/appears in that list EXISTS/);
  });
});

describe("the read-tool named in the hint is one the agent declares", () => {
  it.each(ALL)("%s: every operator_db tool named in the hint is declared", (slug) => {
    const md = agentMd(slug);
    const section = md.slice(md.indexOf(HEADING), md.indexOf(HEADING) + 900);
    const declared = new Set(declaredTools(md));
    const namedInHint = [...section.matchAll(/`(operator_db__[a-z_]+)`/g)].map((m) => m[1]);
    for (const tool of namedInHint) {
      expect(declared.has(tool), `${slug} hint names ${tool} but does not declare it`).toBe(true);
    }
  });

  it.each(BARE_QUERY_AGENTS)("%s points at operator_db__query", (slug) => {
    const md = agentMd(slug);
    const section = md.slice(md.indexOf(HEADING), md.indexOf(HEADING) + 900);
    expect(section).toContain("`operator_db__query`");
  });

  it("chief-of-staff does NOT point at operator_db__query", () => {
    const md = agentMd("chief-of-staff");
    const section = md.slice(md.indexOf(HEADING), md.indexOf(HEADING) + 900);
    expect(section).not.toContain("`operator_db__query`");
    expect(section).toContain("operator_db__query_*");
  });

  it("chief-of-staff still genuinely lacks bare operator_db__query", () => {
    expect(declaredTools(agentMd("chief-of-staff"))).not.toContain("operator_db__query");
  });
});
