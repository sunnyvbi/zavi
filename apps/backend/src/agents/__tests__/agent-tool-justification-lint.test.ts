
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import {
  isMutatingToolName,
  parseToolName,
} from "../../services/agents/liveness/mutating-tools";

const AGENTS_ROOT = path.join(process.cwd(), "src", "agents");

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

function readAgentRaw(slug: string): string {
  return readFileSync(path.join(AGENTS_ROOT, slug, "agent.md"), "utf-8");
}

export function isProposedWrite(name: string): boolean {
  const { verb } = parseToolName(name);
  return /^propose(_|$)/.test(verb);
}

export function isWriteCapableTool(name: string): boolean {
  return isMutatingToolName(name) || isProposedWrite(name);
}

type Frontmatter = {
  tools: string[];
  toolRationale: Record<string, unknown>;
};

function readFrontmatter(raw: string): Frontmatter {
  const fm = matter(raw).data as Record<string, unknown>;
  const praxis = (fm.metadata as Record<string, unknown> | undefined)?.praxis as
    | Record<string, unknown>
    | undefined;
  const toolsRaw = praxis?.tools;
  const tools = Array.isArray(toolsRaw)
    ? toolsRaw.filter((t): t is string => typeof t === "string")
    : [];
  const trRaw = praxis?.tool_rationale;
  const toolRationale =
    trRaw && typeof trRaw === "object" && !Array.isArray(trRaw)
      ? (trRaw as Record<string, unknown>)
      : {};
  return { tools, toolRationale };
}

function hasRationale(fm: Frontmatter, tool: string): boolean {
  const v = fm.toolRationale[tool];
  return typeof v === "string" && v.trim().length > 0;
}

describe("agent-tool-justification-lint (Move E6)", () => {
  const slugs = listAgentSlugs();

  it("finds the agent fleet on disk (sanity check)", () => {
    expect(slugs.length).toBeGreaterThan(10);
    for (const canonical of ["performance-marketer", "chief-of-staff", "operator", "research"]) {
      expect(slugs).toContain(canonical);
    }
  });

  it("every write-capable tool an agent holds carries a one-line tool_rationale", () => {
    const violations: string[] = [];
    for (const slug of slugs) {
      const fm = readFrontmatter(readAgentRaw(slug));
      const writeTools = fm.tools.filter(isWriteCapableTool);
      for (const tool of writeTools) {
        if (!hasRationale(fm, tool)) {
          violations.push(`${slug}/agent.md → "${tool}" is write-capable but has no metadata.praxis.tool_rationale entry`);
        }
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `Move E6 tool-justification lint: these write/side-effecting tool grants ` +
          `are unjustified. Add a specific one-line reason under ` +
          `metadata.praxis.tool_rationale (tool_name: "why this agent needs it"):\n  - ` +
          violations.join("\n  - "),
      );
    }
  });

  it("no tool_rationale entry references a tool the agent no longer holds (anti-rot)", () => {
    const violations: string[] = [];
    for (const slug of slugs) {
      const fm = readFrontmatter(readAgentRaw(slug));
      const held = new Set(fm.tools);
      for (const key of Object.keys(fm.toolRationale)) {
        if (!held.has(key) && isWriteCapableTool(key)) {
          violations.push(`${slug}/agent.md → tool_rationale has a stale entry "${key}" for a tool the agent does not declare`);
        }
      }
    }
    if (violations.length > 0) {
      throw new Error(`Move E6 tool-justification lint (stale rationale):\n  - ${violations.join("\n  - ")}`);
    }
  });

  it("the known write-back agents actually declare + justify their write tools (coverage pin)", () => {
    const pinned: Record<string, string[]> = {
      "performance-marketer": [
        "google_ads__propose_budget_change",
        "google_ads__propose_status_change",
        "meta_ads__propose_budget_change",
        "meta_ads__propose_status_change",
        "meta_ads__propose_new_ad_set",
      ],
      "chief-of-staff": ["outbound__propose_email", "praxis__propose_dispatch"],
      "operator": ["praxis__propose_standing_order"],
      "research": ["praxis__propose_research_watch"],
    };
    for (const [slug, expectedTools] of Object.entries(pinned)) {
      const fm = readFrontmatter(readAgentRaw(slug));
      for (const tool of expectedTools) {
        expect(
          isWriteCapableTool(tool),
          `${tool} must classify as write-capable (E6 predicate regressed?)`,
        ).toBe(true);
        expect(
          fm.tools.includes(tool),
          `${slug}/agent.md must still declare "${tool}"`,
        ).toBe(true);
        expect(
          hasRationale(fm, tool),
          `${slug}/agent.md must carry a tool_rationale for "${tool}"`,
        ).toBe(true);
      }
    }
  });

  it("negative control: isWriteCapableTool fires on writes and not on reads", () => {
    expect(isWriteCapableTool("slack__post_message")).toBe(true);
    expect(isWriteCapableTool("github__open_pr")).toBe(true);
    expect(isWriteCapableTool("stripe__create_payment")).toBe(true);
    expect(isWriteCapableTool("meta_ads__propose_budget_change")).toBe(true);
    expect(isWriteCapableTool("outbound__propose_email")).toBe(true);
    expect(isWriteCapableTool("github__read_file")).toBe(false);
    expect(isWriteCapableTool("meta_ads__list_campaigns")).toBe(false);
    expect(isWriteCapableTool("stripe__list_charges")).toBe(false);
    expect(isWriteCapableTool("web_search__search")).toBe(false);
  });

  it("negative control: the coverage gate flags an agent that holds a write tool with no rationale", () => {
    const unjustified = `---
name: fake
metadata:
  praxis:
    tools:
      - github__read_file
      - meta_ads__propose_budget_change
    tool_rationale:
      # rationale MISSING for the propose tool above
---
body`;
    const fm = readFrontmatter(unjustified);
    const missing = fm.tools.filter(isWriteCapableTool).filter((t) => !hasRationale(fm, t));
    expect(missing).toEqual(["meta_ads__propose_budget_change"]);

    const justified = `---
name: fake
metadata:
  praxis:
    tools:
      - github__read_file
      - meta_ads__propose_budget_change
    tool_rationale:
      meta_ads__propose_budget_change: "Proposes a within-cap Meta budget change that auto-dispatches real spend."
---
body`;
    const fm2 = readFrontmatter(justified);
    const missing2 = fm2.tools.filter(isWriteCapableTool).filter((t) => !hasRationale(fm2, t));
    expect(missing2).toEqual([]);
  });
});
