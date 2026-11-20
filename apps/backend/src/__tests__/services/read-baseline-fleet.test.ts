
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import {
  READ_BASELINE,
  isReadBaselineTool,
  effectiveDeclaredTools,
} from "@/services/mcp/write-allowlist";
import { carriesPrivateData } from "@/services/mcp/egress-policy";

const AGENTS_ROOT = path.join(process.cwd(), "src", "agents");

const VISIBLE_AGENTS = [
  "chief-of-staff",
  "dispute-response",
  "engineer",
  "growth-lead",
  "operator",
  "performance-marketer",
  "pm",
  "qa",
  "research",
  "support-lead",
  "browser-operator",
] as const;

const BASELINE = [...READ_BASELINE];

function readDeclaredTools(slug: string): { tools: string[]; version: unknown } {
  const raw = fs.readFileSync(path.join(AGENTS_ROOT, slug, "agent.md"), "utf-8");
  const fm = matter(raw).data as Record<string, unknown>;
  const meta = (fm.metadata as Record<string, unknown> | undefined) ?? {};
  const praxis = (meta.praxis as Record<string, unknown> | undefined) ?? {};
  const tools = Array.isArray(praxis.tools) ? (praxis.tools as string[]) : [];
  return { tools, version: praxis.version };
}

describe("E-2 fleet guard — READ_BASELINE for every visible agent", () => {
  it("each visible agent's RESOLVED set includes the full baseline", () => {
    for (const slug of VISIBLE_AGENTS) {
      const { tools } = readDeclaredTools(slug);
      const resolved = effectiveDeclaredTools(tools);
      for (const b of BASELINE) {
        expect(
          resolved,
          `${slug}: resolved set missing baseline ${b}`,
        ).toContain(b);
      }
    }
  });

  it("declared ≡ resolved: each spec DECLARES the baseline + carries version", () => {
    for (const slug of VISIBLE_AGENTS) {
      const { tools, version } = readDeclaredTools(slug);
      for (const b of BASELINE) {
        expect(
          tools,
          `${slug}: declared frontmatter must list baseline ${b} (declared≡resolved)`,
        ).toContain(b);
      }
      expect(
        typeof version === "number" && version >= 2,
        `${slug}: metadata.praxis.version must be bumped to >= 2 (got ${String(version)})`,
      ).toBe(true);
    }
  });

  it("baseline never silently grants a PRIVATE-DATA tool: every non-baseline resolved tool ⊆ explicit grants", () => {
    for (const slug of VISIBLE_AGENTS) {
      const { tools } = readDeclaredTools(slug);
      const explicit = new Set(tools);
      const resolved = effectiveDeclaredTools(tools);
      for (const t of resolved) {
        if (carriesPrivateData(t)) {
          expect(
            explicit.has(t),
            `${slug}: private-data tool ${t} is in resolved set but NOT an explicit grant — baseline leaked a private tool`,
          ).toBe(true);
        }
      }
    }
  });

  it("FAIL-SAFE-TO-DENY: a fake/unclassified tool is in NO agent's resolved baseline", () => {
    const FAKE = "totallyfaketool__exfiltrate_everything";
    expect(isReadBaselineTool(FAKE)).toBe(false);
    for (const slug of VISIBLE_AGENTS) {
      const { tools } = readDeclaredTools(slug);
      const resolved = effectiveDeclaredTools(tools);
      expect(resolved, `${slug}: fake tool leaked into resolved set`).not.toContain(FAKE);
    }
    expect(carriesPrivateData(FAKE)).toBe(true);
  });

  it("the hidden `advisor` agent is NOT baselined (E-2 is visible-only)", () => {
    const advisorPath = path.join(AGENTS_ROOT, "advisor", "agent.md");
    if (!fs.existsSync(advisorPath)) return;
    const { tools, version } = readDeclaredTools("advisor");
    const hasAllBaseline = BASELINE.every((b) => tools.includes(b));
    expect(
      hasAllBaseline && version === 2,
      "advisor must NOT carry the full E-2 baseline+version (it is hidden, out of scope)",
    ).toBe(false);
  });
});
