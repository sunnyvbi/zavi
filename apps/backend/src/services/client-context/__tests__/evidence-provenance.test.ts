
import { describe, it, expect } from "vitest";
import {
  assertEvidenceProvenance,
  renderEvidenceCatalog,
} from "@/services/client-context/evidence";
import type { EvidenceRef } from "@/services/client-context/types";

const ref = (over: Partial<EvidenceRef>): EvidenceRef => ({
  source: "site_scan",
  label: "Meta pixel",
  value: "not found on any crawled page",
  observed_at: "2026-09-01T00:00:00Z",
  provenance: "public",
  ...over,
});

describe("assertEvidenceProvenance", () => {
  it("allows descriptive public evidence", () => {
    expect(() => assertEvidenceProvenance([ref({})])).not.toThrow();
  });

  it("allows measured figures on CONNECTED evidence", () => {
    expect(() =>
      assertEvidenceProvenance([
        ref({ provenance: "connected", value: "spend $4,210, ROAS 3.10×" }),
      ]),
    ).not.toThrow();
  });

  it.each([
    ["a dollar figure", "spend $4,210 last week"],
    ["a percentage", "conversion 2.4%"],
    ["a ROAS multiple", "ROAS 3.10×"],
  ])("rejects public evidence carrying %s", (_label, value) => {
    expect(() => assertEvidenceProvenance([ref({ value })])).toThrow(
      /public evidence may not carry measured figures/,
    );
  });

  it("names every offender, not just the first", () => {
    expect(() =>
      assertEvidenceProvenance([
        ref({ label: "A", value: "$1,000" }),
        ref({ label: "B", value: "2.4%" }),
      ]),
    ).toThrow(/A.*B/s);
  });
});

describe("renderEvidenceCatalog", () => {
  const catalog: EvidenceRef[] = [
    ref({ provenance: "connected", label: "Meta spend", value: "$4,210" }),
    ref({ provenance: "public", label: "Blog", value: "last post 7 months ago" }),
  ];

  it("separates the two kinds into labelled blocks", () => {
    const out = renderEvidenceCatalog(catalog);
    expect(out).toContain("MEASURED");
    expect(out).toContain("PUBLIC");
    expect(out).toMatch(/never state them as this company's measured results/);
  });

  it("keeps E-numbering continuous so resolveEvidenceRefs still resolves", () => {
    const out = renderEvidenceCatalog(catalog);
    expect(out).toContain("E1 [site_scan @ 2026-09-01T00:00:00Z] Meta spend");
    expect(out).toContain("E2 [site_scan @ 2026-09-01T00:00:00Z] Blog");
  });

  it("renders a single block when only one kind is present", () => {
    const out = renderEvidenceCatalog([catalog[0]]);
    expect(out).toContain("MEASURED");
    expect(out).not.toContain("PUBLIC");
  });

  it("still reports the empty case", () => {
    expect(renderEvidenceCatalog([])).toMatch(/no grounded evidence/);
  });
});
