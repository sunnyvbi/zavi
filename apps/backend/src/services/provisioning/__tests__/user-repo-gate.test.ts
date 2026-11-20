
import { describe, it, expect } from "vitest";
import {
  assertUserRepoTarget,
  type UserRepoGateDeps,
} from "../user-repo-gate";

function deps(
  row: { mode: string; external_ref: Record<string, unknown> } | null,
  opts: { throws?: boolean } = {},
): UserRepoGateDeps {
  return {
    loadRepoResource: async () => {
      if (opts.throws) throw new Error("simulated tenant_resources read failure");
      return row;
    },
  };
}

const TENANT = "11111111-1111-1111-1111-111111111111";
const USER_REPO = "alice/cool-app";

describe("assertUserRepoTarget — PASS path", () => {
  it("connected mode + name match + user_repo_grant=true → ok", async () => {
    const r = await assertUserRepoTarget(
      TENANT,
      USER_REPO,
      deps({
        mode: "connected",
        external_ref: { github_full_name: USER_REPO, user_repo_grant: true },
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.github_full_name).toBe(USER_REPO);
  });
});

describe("assertUserRepoTarget — FAIL CLOSED", () => {
  it("no tenant_resources row → not ok", async () => {
    const r = await assertUserRepoTarget(TENANT, USER_REPO, deps(null));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no tenant_resources/);
  });

  it("mode='provisioned' (umbrella repo) → not ok (wrong gate)", async () => {
    const r = await assertUserRepoTarget(
      TENANT,
      USER_REPO,
      deps({
        mode: "provisioned",
        external_ref: { github_full_name: USER_REPO, user_repo_grant: true },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not connected/);
  });

  it("github_full_name mismatch → not ok (forged push target)", async () => {
    const r = await assertUserRepoTarget(
      TENANT,
      "evil-actor/private-repo",
      deps({
        mode: "connected",
        external_ref: { github_full_name: USER_REPO, user_repo_grant: true },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/mismatch/);
  });

  it("external_ref.github_full_name missing → not ok", async () => {
    const r = await assertUserRepoTarget(
      TENANT,
      USER_REPO,
      deps({ mode: "connected", external_ref: { user_repo_grant: true } }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/github_full_name missing/);
  });

  it("user_repo_grant flag missing → not ok (connected but not authorized for push-to-main)", async () => {
    const r = await assertUserRepoTarget(
      TENANT,
      USER_REPO,
      deps({ mode: "connected", external_ref: { github_full_name: USER_REPO } }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/user_repo_grant/);
  });

  it("user_repo_grant flag is truthy but not true (e.g. 'yes' string) → not ok (strict ===)", async () => {
    const r = await assertUserRepoTarget(
      TENANT,
      USER_REPO,
      deps({
        mode: "connected",
        external_ref: { github_full_name: USER_REPO, user_repo_grant: "yes" },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/user_repo_grant/);
  });

  it("empty expected name → not ok", async () => {
    const r = await assertUserRepoTarget(
      TENANT,
      "",
      deps({
        mode: "connected",
        external_ref: { github_full_name: USER_REPO, user_repo_grant: true },
      }),
    );
    expect(r.ok).toBe(false);
  });

  it("query error → FAILS CLOSED (not ok, never throws)", async () => {
    const r = await assertUserRepoTarget(TENANT, USER_REPO, deps(null, { throws: true }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("query_error");
  });
});
