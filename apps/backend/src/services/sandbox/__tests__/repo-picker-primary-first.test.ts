import { describe, it, expect, vi, beforeEach } from "vitest";

const callModelMock = vi.fn(async () => {
  throw new Error("callModel reached — the pick should have resolved without Haiku");
});
vi.mock("@/services/llm/call-model", () => ({
  callModel: (...a: unknown[]) => callModelMock(...(a as [])),
}));
vi.mock("@/services/llm/models", () => ({
  DEFAULT_PROVIDER: "anthropic",
  MODELS: { anthropic: { haiku: "claude-haiku-test" } },
}));

const readReadyProfilesMock = vi.fn();
const readTenantDefaultRepoMock = vi.fn(async () => null as string | null);
vi.mock("@/services/sandbox/repo-profiles", () => ({
  readReadyProfiles: (...a: unknown[]) => readReadyProfilesMock(...(a as [])),
  readTenantDefaultRepo: (...a: unknown[]) =>
    readTenantDefaultRepoMock(...(a as [])),
}));

import { pickRepoForTask, repoNamedInTask } from "../repo-picker";

const prof = (repo: string, kind: string, kinds?: string[]) => ({
  repo_full_name: repo,
  kind,
  kinds: kinds ?? [kind],
  language_stats: {},
  frameworks: [],
  topics: [],
  description: null,
  default_branch: "main",
  manifest_paths: [],
  profile_status: "ready" as const,
});

const TENANT = "73db45ff";
const PROFILES = [
  prof("rravi149/OraiCar", "ios"),
  prof("rravi149/OraiCarAndroid", "android"),
  prof("rravi149/upcar", "web", ["web", "backend"]),
  prof("rravi149/upcar-private", "web", ["web", "backend"]),
];
const REPOS = PROFILES.map((p) => p.repo_full_name);

beforeEach(() => {
  callModelMock.mockClear();
  readReadyProfilesMock.mockReset();
  readTenantDefaultRepoMock.mockReset();
  readTenantDefaultRepoMock.mockResolvedValue(null);
});

describe("repo-picker — Primary-first short-circuit", () => {
  it("REGRESSION: backend bug on a 2-monorepo tenant routes to the Primary, not a coin flip", async () => {
    readReadyProfilesMock.mockResolvedValueOnce(PROFILES);
    readTenantDefaultRepoMock.mockResolvedValueOnce("rravi149/upcar");

    const decision = await pickRepoForTask({
      task_description:
        "Fix a bug: when a host refers another host, the referrer receives TWO emails. " +
        "The guest-referral signup email in apps/backend/src/controller/userAuthController.ts " +
        "fires for ALL referrals indiscriminately.",
      repos: REPOS,
      tenant_id: TENANT,
    });

    expect(decision).toEqual({ decision: "pick", repo: "rravi149/upcar" });
    expect(callModelMock).not.toHaveBeenCalled();
  });

  it("a single backend-kind match still resolves deterministically (no default read)", async () => {
    readReadyProfilesMock.mockResolvedValueOnce([
      prof("rravi149/OraiCar", "ios"),
      prof("rravi149/upcar", "web", ["web", "backend"]),
      prof("rravi149/apna-tutor", "web"),
    ]);

    const decision = await pickRepoForTask({
      task_description: "add a migration to the backend database",
      repos: ["rravi149/OraiCar", "rravi149/upcar", "rravi149/apna-tutor"],
      tenant_id: TENANT,
    });

    expect(decision).toEqual({ decision: "pick", repo: "rravi149/upcar" });
    expect(readTenantDefaultRepoMock).not.toHaveBeenCalled();
    expect(callModelMock).not.toHaveBeenCalled();
  });

  it("native routing is NOT swallowed by the Primary (the 2026-06-04 regression)", async () => {
    readReadyProfilesMock.mockResolvedValueOnce(PROFILES);
    readTenantDefaultRepoMock.mockResolvedValue("rravi149/upcar");

    const decision = await pickRepoForTask({
      task_description: "fix the SwiftUI crash on the iPhone booking screen",
      repos: REPOS,
      tenant_id: TENANT,
    });

    expect(decision).toEqual({ decision: "pick", repo: "rravi149/OraiCar" });
    expect(readTenantDefaultRepoMock).not.toHaveBeenCalled();
  });

  it("an explicitly NAMED repo outranks the Primary", async () => {
    readReadyProfilesMock.mockResolvedValueOnce(PROFILES);
    readTenantDefaultRepoMock.mockResolvedValue("rravi149/upcar");

    const decision = await pickRepoForTask({
      task_description: "fix the operator tier gate in upcar-private",
      repos: REPOS,
      tenant_id: TENANT,
    });

    expect(decision).toEqual({ decision: "pick", repo: "rravi149/upcar-private" });
  });

  it("no tenant default → still falls through to Haiku (needs_pick path unchanged)", async () => {
    readReadyProfilesMock.mockResolvedValueOnce(PROFILES);
    readTenantDefaultRepoMock.mockResolvedValueOnce(null);
    callModelMock.mockResolvedValueOnce({
      text: '{"decision":"ask","message":"which repo?"}',
    } as never);

    const decision = await pickRepoForTask({
      task_description: "tidy up the referral emails",
      repos: REPOS,
      tenant_id: TENANT,
    });

    expect(decision.decision).toBe("ask");
    expect(callModelMock).toHaveBeenCalledTimes(1);
  });

  it("a default pointing at a repo outside the candidate set is ignored", async () => {
    readReadyProfilesMock.mockResolvedValueOnce(PROFILES);
    readTenantDefaultRepoMock.mockResolvedValueOnce("rravi149/apna-tutor");
    callModelMock.mockResolvedValueOnce({
      text: '{"decision":"ask","message":"which repo?"}',
    } as never);

    const decision = await pickRepoForTask({
      task_description: "tidy up the referral emails",
      repos: REPOS,
      tenant_id: TENANT,
    });

    expect(decision.decision).toBe("ask");
  });

  it("a default read failure degrades to Haiku instead of blocking the pick", async () => {
    readReadyProfilesMock.mockResolvedValueOnce(PROFILES);
    readTenantDefaultRepoMock.mockRejectedValueOnce(new Error("db down"));
    callModelMock.mockResolvedValueOnce({
      text: '{"decision":"pick","repo":"rravi149/upcar"}',
    } as never);

    const decision = await pickRepoForTask({
      task_description: "tidy up the referral emails",
      repos: REPOS,
      tenant_id: TENANT,
    });

    expect(decision).toEqual({ decision: "pick", repo: "rravi149/upcar" });
  });
});

describe("repoNamedInTask", () => {
  const repos = ["rravi149/upcar", "rravi149/upcar-private", "rravi149/OraiCar"];

  it("matches a bare repo name as a whole token", () => {
    expect(repoNamedInTask("please patch upcar-private today", repos)).toBe(
      "rravi149/upcar-private",
    );
  });

  it("does NOT let a prefix repo shadow a longer one", () => {
    expect(repoNamedInTask("patch upcar-private", repos)).toBe(
      "rravi149/upcar-private",
    );
  });

  it("two named repos is not a routing signal", () => {
    expect(
      repoNamedInTask("port the fix from upcar to upcar-private", repos),
    ).toBeNull();
  });

  it("no mention → null", () => {
    expect(repoNamedInTask("fix the referral emails", repos)).toBeNull();
  });

  it("a FILE PATH does not impersonate a repo of the same name", () => {
    const r = ["acme/api", "acme/upcar"];
    expect(repoNamedInTask("patch apps/api/handler.ts please", r)).toBeNull();
  });

  it("a generic bare name is not a routing signal", () => {
    const r = ["acme/api", "acme/upcar"];
    expect(repoNamedInTask("fix the API endpoint that 500s", r)).toBeNull();
  });

  it("but the QUALIFIED owner/name selects even a generic repo", () => {
    const r = ["acme/api", "acme/upcar"];
    expect(repoNamedInTask("fix acme/api please", r)).toBe("acme/api");
  });

  it("a dotted token does not match a bare prefix", () => {
    const r = ["acme/upcar", "acme/other"];
    expect(repoNamedInTask("see upcar.config.ts", r)).toBeNull();
  });

  it("a pasted GitHub URL names the repo, even a generic one", () => {
    const r = ["acme/api", "acme/upcar"];
    expect(
      repoNamedInTask("repro here https://github.com/acme/api/issues/1", r),
    ).toBe("acme/api");
  });

  it("the qualified form still respects name boundaries", () => {
    const r = ["acme/api", "acme/upcar"];
    expect(repoNamedInTask("see github.com/acme/api-v2/pull/3", r)).toBeNull();
    expect(repoNamedInTask("see github.com/acme/apifoo", r)).toBeNull();
  });
});
