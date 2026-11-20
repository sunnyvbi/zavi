
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import matter from "gray-matter";

const AGENTS_ROOT = path.join(process.cwd(), "src", "agents");

const EXPECTED_PDF_AGENTS = new Set([
  "advisor",
  "chief-of-staff",
  "pm",
  "engineer",
  "operator",
  "support-lead",
  "growth-lead",
  "research",
  "qa",
  "dispute-response",
  "performance-marketer",
]);

function listAgentSlugs(): string[] {
  return readdirSync(AGENTS_ROOT)
    .filter((entry) => {
      if (entry.startsWith("_") || entry.startsWith(".")) return false;
      const full = path.join(AGENTS_ROOT, entry);
      if (!statSync(full).isDirectory()) return false;
      return existsSync(path.join(full, "agent.md"));
    })
    .sort();
}

const EXPECTED_SOCIAL_IMAGE_AGENTS = new Set([
  "operator",
  "growth-lead",
  "performance-marketer",
  "content-design",
]);

function agentDeclaresTool(slug: string, tool: string): boolean {
  const body = readFileSync(
    path.join(AGENTS_ROOT, slug, "agent.md"),
    "utf-8",
  );
  const parsed = matter(body);
  const fm = parsed.data as Record<string, unknown>;
  const praxis = (fm.metadata as { praxis?: Record<string, unknown> } | undefined)
    ?.praxis;
  const tools = (praxis?.tools as unknown[]) ?? [];
  return Array.isArray(tools) && tools.includes(tool);
}

function agentDeclaresPdfTool(slug: string): boolean {
  const body = readFileSync(
    path.join(AGENTS_ROOT, slug, "agent.md"),
    "utf-8",
  );
  const parsed = matter(body);
  const fm = parsed.data as Record<string, unknown>;
  const praxis = (fm.metadata as { praxis?: Record<string, unknown> } | undefined)
    ?.praxis;
  const tools = (praxis?.tools as unknown[]) ?? [];
  return Array.isArray(tools) && tools.includes("report__render_pdf");
}

describe("PDF-fleet wiring — report__render_pdf tool surface", () => {
  it("the expected minimum set of agents declares report__render_pdf", () => {
    const allSlugs = listAgentSlugs();
    const wiredAgents = new Set(
      allSlugs.filter((slug) => agentDeclaresPdfTool(slug)),
    );

    for (const expected of EXPECTED_PDF_AGENTS) {
      expect(
        wiredAgents.has(expected),
        `${expected} agent.md must declare report__render_pdf in tools:`,
      ).toBe(true);
    }
  });

  it("the expected set of agents declares report__render_social_image", () => {
    const allSlugs = listAgentSlugs();
    for (const expected of EXPECTED_SOCIAL_IMAGE_AGENTS) {
      expect(
        allSlugs.includes(expected),
        `${expected} must exist in the fleet`,
      ).toBe(true);
      expect(
        agentDeclaresTool(expected, "report__render_social_image"),
        `${expected} agent.md must declare report__render_social_image in tools:`,
      ).toBe(true);
    }
  });

  it("the operator prompt routes text-bearing social creative to render_social_image", () => {
    const body = readFileSync(
      path.join(AGENTS_ROOT, "operator", "agent.md"),
      "utf-8",
    );
    expect(body).toContain(
      "Social / ad creative — anything with text on it → `report__render_social_image`",
    );
    expect(body).toContain(
      "A plain photograph with no words on it → `report__generate_image`",
    );
  });

  it("advisor visibility is enabled (Phase 2.5 lock — Review-Q1)", () => {
    const body = readFileSync(
      path.join(AGENTS_ROOT, "advisor", "agent.md"),
      "utf-8",
    );
    const parsed = matter(body);
    const fm = parsed.data as Record<string, unknown>;
    const praxis = (fm.metadata as { praxis?: Record<string, unknown> } | undefined)
      ?.praxis;
    const visibility = praxis?.visibility as
      | { default_state?: string }
      | undefined;
    expect(visibility?.default_state).toBe("enabled");
  });
});

describe("advisor agent.md — thin-prompt regression lock", () => {
  it("contains the 'Thin prompts ALWAYS trigger Phase 1' lock-line", () => {
    const body = readFileSync(
      path.join(AGENTS_ROOT, "advisor", "agent.md"),
      "utf-8",
    );
    expect(body).toMatch(/Thin prompts ALWAYS trigger Phase 1/);
  });

  it("contains the HARD CONTRACT against 'questions above' lying", () => {
    const body = readFileSync(
      path.join(AGENTS_ROOT, "advisor", "agent.md"),
      "utf-8",
    );
    expect(body).toMatch(/HARD CONTRACT/);
    expect(body).toMatch(/MUST NOT use the words/);
  });

  it("contains the 2 thin-prompt examples", () => {
    const body = readFileSync(
      path.join(AGENTS_ROOT, "advisor", "agent.md"),
      "utf-8",
    );
    expect(body).toMatch(/Thin-prompt example 1.*"hi"/);
    expect(body).toMatch(/Thin-prompt example 2.*"what should I do"/);
  });
});
