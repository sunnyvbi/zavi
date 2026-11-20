import { describe, it, expect, vi, beforeEach } from "vitest";

const gate = vi.hoisted(() => ({
  spy: vi.fn(),
  impl: null as null | ((...a: unknown[]) => Promise<unknown>),
}));
vi.mock("@/services/provisioning/provisioned-repo-gate", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  assertProvisionedRepoTarget: (...a: unknown[]) => (gate.impl ? gate.impl(...a) : gate.spy(...a)),
}));
const gateSpy = gate.spy;

import {
  customerVerificationNotes,
  collectVerificationNotes,
  appendTestingSection,
  buildTestingSection,
} from "../ship-gate";
import { resolvePrAudience } from "../post-run";

const noisyEnvelope = {
  repo: "acme/web",
  base_branch: "development",
  risk_class: "low",
  verify: { status: "couldnt_run", attempts: 1 },
  typecheck_verify: {
    status: "failed",
    error_count: 1,
    errors: ["src/a.ts(1,1): error TS2307: Cannot find module 'exceljs'"],
  },
  http_route_changed: true,
  diagnosis: { reproduced: false, not_reproduced_reason: "no database in the sandbox" },
  stale_committed_dist: [{ pkgRoot: "apps/backend", srcFiles: ["apps/backend/src/a.ts"] }],
};

describe("customerVerificationNotes — only what the change provably broke", () => {
  it("the prod noise case yields no notes at all (the full list still has them)", () => {
    expect(customerVerificationNotes(noisyEnvelope)).toEqual([]);
    expect(collectVerificationNotes(noisyEnvelope).length).toBeGreaterThan(3);
  });

  it("a test that passed on the base and fails with the change is named", () => {
    const notes = customerVerificationNotes({
      ...noisyEnvelope,
      verify: { status: "failed", attempts: 1 },
      test_attribution: { kind: "attributed", new_failures: ["checkout > applies tax"], pre_existing: ["x"] },
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("`checkout > applies tax`");
    expect(notes[0]).toContain("`development`");
    expect(notes[0]).toContain("Fix before merge");
  });

  it("caps the names at three and counts the rest", () => {
    const [note] = customerVerificationNotes({
      verify: { status: "failed" },
      base_branch: "main",
      test_attribution: { kind: "attributed", new_failures: ["a", "b", "c", "d", "e"], pre_existing: [] },
    });
    expect(note).toContain("breaks 5 tests");
    expect(note).toContain("(+2 more)");
    expect(note).not.toContain("`d`");
  });

  it("red tests the change did NOT cause, or could not attribute, stay off the PR", () => {
    expect(
      customerVerificationNotes({
        verify: { status: "failed" },
        test_attribution: { kind: "attributed", new_failures: [], pre_existing: ["old"] },
      }),
    ).toEqual([]);
    expect(
      customerVerificationNotes({
        verify: { status: "failed" },
        test_attribution: { kind: "unknown", why: "base suite could not run" },
      }),
    ).toEqual([]);
    expect(customerVerificationNotes({ verify: { status: "failed" } })).toEqual([]);
  });

  it("a change the model labelled trivial is still named when it provably broke a test", () => {
    expect(
      customerVerificationNotes({
        risk_class: "trivial",
        verify: { status: "failed" },
        test_attribution: { kind: "attributed", new_failures: ["a"], pre_existing: [] },
      }),
    ).toHaveLength(1);
  });

  it("a branch or test name with backticks cannot break the markdown", () => {
    const [note] = customerVerificationNotes({
      verify: { status: "failed" },
      base_branch: "release/`v2`",
      test_attribution: { kind: "attributed", new_failures: ["renders `code`"], pre_existing: [] },
    });
    expect(note).toContain("`release/'v2'`");
    expect(note).toContain("`renders 'code'`");
    expect((note.match(/`/g) ?? []).length % 2).toBe(0);
  });
});

describe("testing section intro per audience", () => {
  it("customer PRs get a plain intro, Zavi-built PRs keep today's", () => {
    expect(buildTestingSection(["Tests: x"], "customer")).toContain("_Zavi found a problem this change causes:_");
    expect(buildTestingSection(["Tests: x"])).toContain("_Automated checks that did not fully pass");
    expect(appendTestingSection("body", [], undefined, "customer")).toBe("body");
  });
});

describe("resolvePrAudience", () => {
  beforeEach(() => {
    gateSpy.mockReset();
    gate.impl = null;
  });

  it("zavi_built only when the proposal repo is the run's repo and the gate proves ownership", async () => {
    gateSpy.mockResolvedValue({ ok: true, github_full_name: "Praxis-build/site-1" });
    expect(await resolvePrAudience("t1", { repo: "Praxis-build/site-1" }, "Praxis-build/site-1")).toBe("zavi_built");
    expect(gateSpy).toHaveBeenCalledWith("t1", "Praxis-build/site-1");
  });

  it("a customer repo the gate does not own is customer", async () => {
    gateSpy.mockResolvedValue({ ok: false, reason: "no provisioned repo" });
    expect(await resolvePrAudience("t1", { repo: "acme/web" }, "acme/web")).toBe("customer");
  });

  it("a proposal naming a different repo than the run is customer, without asking the gate", async () => {
    expect(await resolvePrAudience("t1", { repo: "Praxis-build/site-1" }, "acme/web")).toBe("customer");
    expect(gateSpy).not.toHaveBeenCalled();
  });

  it("a gate error fails closed to customer", async () => {
    let calls = 0;
    gate.impl = async () => {
      calls += 1;
      throw new Error("db down");
    };
    expect(await resolvePrAudience("t1", { repo: "Praxis-build/site-1" }, "Praxis-build/site-1")).toBe("customer");
    expect(calls).toBe(1);
  });
});
