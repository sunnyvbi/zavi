import { describe, it, expect, vi, beforeEach } from "vitest";
import { runCtoPostRun } from "../post-run";
import { BuilderRejectedError } from "@/services/pr-builder/from-sandbox-fs";
import { BuilderPolicyRefusedError, isBuilderPolicyRefusal } from "@/services/agents/run-failure-code";

const { buildSpy, verifySpy, flag } = vi.hoisted(() => ({
  buildSpy: vi.fn(),
  verifySpy: vi.fn(),
  flag: { on: false },
}));
vi.mock("@/services/sandbox/lifecycle", () => ({ getSandboxIdForRun: async () => "sbx-1" }));
vi.mock("@/services/pr-builder/from-sandbox-fs", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  buildPrFilesFromSandboxFs: buildSpy,
}));
vi.mock("@/services/sites/site-build-target", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  verifySiteRepoRun: verifySpy,
}));
vi.mock("../product-builder-flag", () => ({ isProductBuilderEnabled: async () => flag.on }));
vi.mock("@/services/agents/engineer-large-diff-allowlist", () => ({
  isEngineerLargeDiffAllowlisted: async () => false,
}));
vi.mock("@/services/agents/log-decision-not-taken", () => ({
  logDecisionNotTaken: async () => undefined,
}));
vi.mock("@/services/agents/run-stop", () => ({ isRunStopRequested: async () => false }));

const TENANT = "11111111-1111-1111-1111-111111111111";
const SITE = "5e0b8edd-9e1a-4dd5-a4be-18997fb92ebe";
const REPO = "Zavi-Latest-Build/austin-dog-grooming-d0ca391e-5e0b8e";
const MIGRATION = "supabase/migrations/001_appointments.sql";

const ctx = () =>
  ({
    tenant_id: TENANT,
    runId: "22222222-2222-2222-2222-222222222222",
    agent: { slug: "engineer" },
    emitProgress: vi.fn(async () => undefined),
  }) as never;
const envelope = () => ({ repo: REPO, base_branch: "main", title: "Book appointments", body: "Adds booking." });

const buildPayload = () => ({
  stage: "build",
  fast_single_pass: true,
  site_id: SITE,
  build_conductor_run_id: "b2b0c74d-b648-41b3-8451-252324125198",
  target: { github_full_name: REPO, github_target_mode: "umbrella", default_branch: "main" },
  repo_hint: REPO,
});

beforeEach(() => {
  buildSpy.mockReset();
  verifySpy.mockReset();
  flag.on = false;
});

describe("site migration exemption reaches the PR builder", () => {
  it("a verified site build passes site_repo even when product-build codegen detection is off", async () => {
    verifySpy.mockResolvedValue({ ok: true });
    buildSpy.mockResolvedValue({ files: [] });
    await runCtoPostRun(ctx(), envelope(), buildPayload(), []);
    expect(verifySpy).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: TENANT, repo_full_name: REPO }),
    );
    expect(buildSpy).toHaveBeenCalledWith(expect.objectContaining({ site_repo: true }));
  });

  it("a verified site EDIT (no stage) passes site_repo too", async () => {
    verifySpy.mockResolvedValue({ ok: true });
    buildSpy.mockResolvedValue({ files: [] });
    await runCtoPostRun(ctx(), envelope(), { site_id: SITE, repo_hint: REPO, task_description: "add reviews" }, []);
    expect(buildSpy).toHaveBeenCalledWith(expect.objectContaining({ site_repo: true }));
  });

  it("an unverified site run (row says otherwise) never gets site_repo", async () => {
    verifySpy.mockResolvedValue({ ok: false, reason: "other_site" });
    buildSpy.mockResolvedValue({ files: [] });
    await runCtoPostRun(ctx(), envelope(), buildPayload(), []);
    expect(buildSpy.mock.calls[0][0]).not.toHaveProperty("site_repo");
  });

  it("a run with no site_id never even asks (Zavi's own and customer repos keep the folder forbidden)", async () => {
    buildSpy.mockResolvedValue({ files: [] });
    await runCtoPostRun(ctx(), envelope(), { repo_hint: "acme/web", task_description: "x" }, []);
    expect(verifySpy).not.toHaveBeenCalled();
    expect(buildSpy.mock.calls[0][0]).not.toHaveProperty("site_repo");
  });
});

describe("a forbidden_path refusal names its paths and does not buy repairs", () => {
  it("a conductor build stage fails AS ITSELF with every refused path (no repair, no native retry)", async () => {
    verifySpy.mockResolvedValue({ ok: false, reason: "not_buildable", status: "failed" });
    buildSpy.mockRejectedValue(
      new BuilderRejectedError({ kind: "forbidden_path", path: MIGRATION, paths: [MIGRATION, ".env"] }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const err = await runCtoPostRun(ctx(), envelope(), buildPayload(), []).catch((e) => e);
    expect(err).toBeInstanceOf(BuilderPolicyRefusedError);
    expect((err as BuilderPolicyRefusedError).run_failure_code).toBe("builder_policy_refused");
    expect(isBuilderPolicyRefusal((err as Error).message)).toBe(true);
    expect((err as Error).message).toContain(MIGRATION);
    expect((err as Error).message).toContain(".env");
    const line = warn.mock.calls.map((c) => String(c[0])).find((s) => s.includes("builder refused forbidden_path"));
    expect(line).toBeDefined();
    expect(line).toContain(MIGRATION);
    expect(line).toContain("not_applied:not_buildable:failed");
    warn.mockRestore();
  });

  it("a chat run still suppresses, with the paths in the reply", async () => {
    buildSpy.mockRejectedValue(new BuilderRejectedError({ kind: "forbidden_path", path: ".github/workflows/x.yml" }));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const out = await runCtoPostRun(ctx(), envelope(), { repo_hint: "acme/web", task_description: "x" }, []);
    expect(out.kind).toBe("suppress");
    if (out.kind === "suppress") {
      expect(out.reason).toBe("builder_rejected:forbidden_path");
      expect(out.output_text).toContain(".github/workflows/x.yml");
    }
  });
});
