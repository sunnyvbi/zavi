
import { describe, it, expect } from "vitest";
import {
  assertProvisionedRepoTarget,
  type ProvisionedRepoGateDeps,
} from "../provisioned-repo-gate";

function deps(
  row: { mode: string; external_ref: Record<string, unknown> } | null,
  opts: { throws?: boolean } = {},
): ProvisionedRepoGateDeps {
  return {
    loadRepoResource: async () => {
      if (opts.throws) throw new Error("simulated tenant_resources read failure");
      return row;
    },
  };
}

const TENANT = "11111111-1111-1111-1111-111111111111";
const REPO = "praxis-built/acme";

describe("assertProvisionedRepoTarget — PASS path", () => {
  it("provisioned mode + exact github_full_name match → ok", async () => {
    const r = await assertProvisionedRepoTarget(
      TENANT,
      REPO,
      deps({ mode: "provisioned", external_ref: { github_full_name: REPO } }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.github_full_name).toBe(REPO);
  });
});

describe("assertProvisionedRepoTarget — FAIL CLOSED", () => {
  it("no tenant_resources row → not ok", async () => {
    const r = await assertProvisionedRepoTarget(TENANT, REPO, deps(null));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no tenant_resources/);
  });

  it("mode='connected' (customer's own repo) → not ok", async () => {
    const r = await assertProvisionedRepoTarget(
      TENANT,
      REPO,
      deps({ mode: "connected", external_ref: { github_full_name: REPO } }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not provisioned/);
  });

  it("github_full_name mismatch (points at a different repo) → not ok", async () => {
    const r = await assertProvisionedRepoTarget(
      TENANT,
      "rravi149/praxis",
      deps({ mode: "provisioned", external_ref: { github_full_name: REPO } }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/mismatch/);
  });

  it("external_ref.github_full_name missing → not ok", async () => {
    const r = await assertProvisionedRepoTarget(
      TENANT,
      REPO,
      deps({ mode: "provisioned", external_ref: {} }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/github_full_name missing/);
  });

  it("empty expected name → not ok", async () => {
    const r = await assertProvisionedRepoTarget(
      TENANT,
      "",
      deps({ mode: "provisioned", external_ref: { github_full_name: REPO } }),
    );
    expect(r.ok).toBe(false);
  });

  it("query error → FAILS CLOSED (not ok, never throws)", async () => {
    const r = await assertProvisionedRepoTarget(TENANT, REPO, deps(null, { throws: true }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("query_error");
  });
});
