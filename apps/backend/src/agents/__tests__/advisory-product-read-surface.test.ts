
import { describe, it, expect } from "vitest";
import { listAgents } from "@/services/agents/registry";

const ADVISORY_SLUGS = [
  "growth-lead",
  "advisor",
  "pm",
  "support-lead",
  "chief-of-staff",
  "research",
  "performance-marketer",
  "qa",
  "dispute-response",
  "content-design",
];

const NEW_TOOLS = [
  "github__read_file",
  "github__search_code",
  "github__list_files",
  "product__probe",
];

describe("T6 — advisory agents parse with the new product-read tools", () => {
  const all = listAgents();

  for (const slug of ADVISORY_SLUGS) {
    it(`${slug} parses and declares all 4 product-read tools`, () => {
      const a = all.find((x) => x.slug === slug);
      expect(a, `${slug} not found in listAgents() — agent.md missing/unparseable`).toBeDefined();
      const tools = a!.metadata_praxis.tools;
      for (const t of NEW_TOOLS) {
        expect(tools, `${slug} missing ${t}`).toContain(t);
      }
    });

    it(`${slug}'s tool names all parse as <server>__<tool>`, () => {
      const a = all.find((x) => x.slug === slug)!;
      for (const t of a.metadata_praxis.tools) {
        expect(t, `${slug} tool ${t} malformed`).toMatch(/^[a-z0-9_]+__[a-z0-9_*]+$/);
      }
    });
  }

  it("advisor gets product__probe but NOT raw web_fetch (scoped egress, plan H/P0.b)", () => {
    const advisor = all.find((x) => x.slug === "advisor")!;
    expect(advisor.metadata_praxis.tools).toContain("product__probe");
    expect(advisor.metadata_praxis.tools).not.toContain("web_fetch__fetch");
  });
});

describe("FIX 1 — every advisory agent declares github as OPTIONAL (no setup_required gate)", () => {
  const all = listAgents();

  for (const slug of ADVISORY_SLUGS) {
    it(`${slug} lists github in setup.optional_connectors`, () => {
      const a = all.find((x) => x.slug === slug)!;
      const optional =
        (a.metadata_praxis as { setup?: { optional_connectors?: string[] } })
          .setup?.optional_connectors ?? [];
      expect(
        optional,
        `${slug} must declare github optional or no-repo tenants get a setup_required short-circuit`,
      ).toContain("github");
    });
  }
});

describe("T6 — engineer/operator tool sets UNCHANGED (regression guard)", () => {
  const all = listAgents();

  it("engineer does NOT gain product__probe", () => {
    const engineer = all.find((x) => x.slug === "engineer");
    if (engineer) {
      expect(engineer.metadata_praxis.tools).not.toContain("product__probe");
    }
  });

  it("operator does NOT gain product__probe", () => {
    const operator = all.find((x) => x.slug === "operator");
    expect(operator, "operator agent should exist").toBeDefined();
    expect(operator!.metadata_praxis.tools).not.toContain("product__probe");
  });

  it("operator still holds its core read tools (no accidental removal)", () => {
    const operator = all.find((x) => x.slug === "operator")!;
    for (const t of ["operator_db__catalog", "memory__search"]) {
      expect(operator.metadata_praxis.tools).toContain(t);
    }
  });
});
