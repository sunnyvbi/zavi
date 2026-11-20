import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/tenant-client", () => ({ staffCrossTenantClient: vi.fn(), asTenantId: (t: string) => t, tenantClient: vi.fn(), tenantRpc: vi.fn(), opsRpc: vi.fn() }));
vi.mock("@/services/agents/continue-build", () => ({ continueBuild: vi.fn(), continueRefusal: vi.fn() }));

import {
  applyBuildContinue,
  BuildContinueNotFound,
  buildContinueSchema,
  continueConfirmPhrase,
  previewBuildContinue,
  type BuildContinueDeps,
  type StuckBuild,
} from "../build-continue";
import { getScript } from "../registry";

const RUN = "e419a12a-e1c2-4f07-a6b6-6748021f4963";
const OWNER = "c5b88a77-0000-4000-8000-000000000001";

const build = (over: Partial<StuckBuild> = {}): StuckBuild => ({
  run_id: RUN,
  tenant_id: OWNER,
  status: "paused",
  paused_at: "2026-10-01T10:50:00Z",
  updated_at: "2026-10-01T10:50:00Z",
  failure_class: "repair_exhausted",
  failure_reason: null,
  spend_usd: 1,
  max_usd: 10,
  site: { id: "a4f85053-6f1b-4c8f-acf7-213977f5ac49", label: "bespoke", hostname: "bespoke.zaviagent.com", status: "publishing" },
  refusal: null,
  ...over,
});

const deps = (row: StuckBuild | null): BuildContinueDeps & { continueBuild: ReturnType<typeof vi.fn> } => ({
  readBuild: vi.fn().mockResolvedValue(row),
  continueBuild: vi.fn().mockResolvedValue({ ok: true, run_id: RUN }),
});

describe("build-continue admin script", () => {
  it("resumes in the workspace read from the build row, never from input", async () => {
    const d = deps(build());
    const out = await applyBuildContinue(RUN, d);
    expect(d.continueBuild).toHaveBeenCalledWith(OWNER, RUN);
    expect(out.result).toEqual({ ok: true, run_id: RUN });
  });

  it("an unknown build id is not found and continues nothing", async () => {
    const d = deps(null);
    await expect(applyBuildContinue(RUN, d)).rejects.toBeInstanceOf(BuildContinueNotFound);
    await expect(previewBuildContinue(RUN, d)).rejects.toBeInstanceOf(BuildContinueNotFound);
    expect(d.continueBuild).not.toHaveBeenCalled();
  });

  it("a refusal from continueBuild is reported, not hidden", async () => {
    const d = deps(build());
    d.continueBuild.mockResolvedValue({ ok: false, code: "expired", message: "This build was paused for more than 7 days." });
    const out = await applyBuildContinue(RUN, d);
    expect(out.result).toMatchObject({ ok: false, code: "expired" });
  });

  it("dry run shows the build and the exact confirm phrase, and changes nothing", async () => {
    const d = deps(build());
    const p = await previewBuildContinue(RUN, d);
    expect(p.confirm_phrase).toBe(`CONTINUE ${RUN}`);
    expect(p.site?.status).toBe("publishing");
    expect(d.continueBuild).not.toHaveBeenCalled();
  });

  it("validates the build id and lowercases it", () => {
    expect(buildContinueSchema.safeParse({ run_id: "not-a-uuid" }).success).toBe(false);
    expect(buildContinueSchema.parse({ run_id: RUN.toUpperCase() }).run_id).toBe(RUN);
    expect(continueConfirmPhrase(RUN)).toBe(`CONTINUE ${RUN}`);
    expect(continueConfirmPhrase(RUN)).not.toBe(continueConfirmPhrase("e419a12a-0000-4000-8000-000000000000"));
  });

  it("is registered, applies, and locks per build", async () => {
    const s = getScript("build-continue");
    expect(s).toBeDefined();
    expect(s?.applies).toBe(true);
    expect(s?.lockKey({ run_id: RUN })).toBe(RUN);
    await expect(s!.prepareApply!({ run_id: RUN }, { staff: { user_id: "u", email: "e" }, env: {} }, "CONTINUE wrong")).rejects.toMatchObject({ code: "confirm_mismatch" });
  });
});
