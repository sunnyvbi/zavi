import { describe, it, expect, vi } from "vitest";
import {
  resolveVersionCommit,
  DraftNotPublished,
  type RefineUndoDeps,
} from "@/services/agents/refine-undo";
import { restoreDraftAfterReset } from "@/services/build/live-edit";

const SHA_R1 = "1111567890aaaa567890aaaa567890aaaa567890";
const SHA_R2 = "2222567890aaaa567890aaaa567890aaaa567890";
const SHA_BUILD = "0000567890aaaa567890aaaa567890aaaa567890";
const TARGET = { github_full_name: "praxis-built/acme", default_branch: "main" };

function refine(id: string, sha: string | null, message = `refine ${id}`) {
  return {
    conductor_run_id: id,
    child_run_id: `ar_${id}`,
    output_text: "shipped",
    parsed: sha ? { commit_sha: sha, title: message } : { title: message, head_branch: "engineer/x", base_branch: "main" },
    message,
  };
}

type Mocked = RefineUndoDeps & {
  restoreOnMain: ReturnType<typeof vi.fn>;
  readCommitParentSha: ReturnType<typeof vi.fn>;
  insertUndoRun: ReturnType<typeof vi.fn>;
  revertOnMain: ReturnType<typeof vi.fn>;
  loadShippedRefineById: ReturnType<typeof vi.fn>;
  loadEarliestShippedRefine: ReturnType<typeof vi.fn>;
  listRecentCommits: ReturnType<typeof vi.fn>;
  listBranches?: ReturnType<typeof vi.fn>;
  loadBuildRootRun?: ReturnType<typeof vi.fn>;
  loadRestoreRun?: ReturnType<typeof vi.fn>;
};

function deps(over: Partial<RefineUndoDeps> = {}): Mocked {
  return {
    loadLatestShippedRefine: vi.fn().mockResolvedValue(refine("r2", SHA_R2)),
    loadProvisionedTarget: vi.fn().mockResolvedValue({ ...TARGET }),
    assertProvisionedRepo: {
      loadRepoResource: vi.fn().mockResolvedValue({ mode: "provisioned", external_ref: { github_full_name: TARGET.github_full_name } }),
    },
    resolveInstallation: vi.fn().mockResolvedValue(-1),
    readBranchHeadSha: vi.fn().mockResolvedValue(null),
    listRecentCommits: vi.fn().mockResolvedValue([]),
    revertOnMain: vi.fn(),
    insertUndoRun: vi.fn().mockResolvedValue("cr_restore_1"),
    loadShippedRefineById: vi.fn(async (_t: string, id: string) => (id === "r1" ? refine("r1", SHA_R1, "Darker hero") : id === "r2" ? refine("r2", SHA_R2) : null)),
    loadEarliestShippedRefine: vi.fn().mockResolvedValue(refine("r1", SHA_R1, "Darker hero")),
    loadBuildCheckpointSha: vi.fn().mockResolvedValue(null),
    readCommitParentSha: vi.fn().mockResolvedValue(SHA_BUILD),
    restoreOnMain: vi.fn().mockResolvedValue({ restored: true, branch: "main", new_commit_sha: "9999567890aaaa567890aaaa567890aaaa567890", noop: false }),
    ...over,
  } as unknown as Mocked;
}

function draftRefine(id: string, sha: string) {
  return {
    conductor_run_id: id,
    child_run_id: `ar_${id}`,
    output_text: "saved to draft",
    parsed: { commit_sha: sha, live_edit_draft_sha: sha, title: "Draft change" },
    message: "Draft change",
  };
}

describe("an unpublished live-edit draft can never resolve as a restore target", () => {
  it("History 'Revert to this version' refuses an unpublished draft version and writes nothing", async () => {
    const d = deps({
      loadShippedRefineById: vi.fn().mockResolvedValue(draftRefine("r3", SHA_R2)),
      isOnDefaultBranch: vi.fn().mockResolvedValue(false),
    });
    await expect(
      resolveVersionCommit({ tenant_id: "t1", conductor_run_id: "r3", purpose: "restore" }, d),
    ).rejects.toBeInstanceOf(DraftNotPublished);
  });

  it("previewing a draft version is still allowed (read-only), so History can show it", async () => {
    const isOnDefaultBranch = vi.fn().mockResolvedValue(false);
    const d = deps({ loadShippedRefineById: vi.fn().mockResolvedValue(draftRefine("r3", SHA_R2)), isOnDefaultBranch });
    const v = await resolveVersionCommit({ tenant_id: "t1", conductor_run_id: "r3", purpose: "preview" }, d);
    expect(v.commit_sha).toBe(SHA_R2);
    expect(isOnDefaultBranch).not.toHaveBeenCalled();
  });
});

describe("restoreDraftAfterReset", () => {
  const input = { sandbox_id: "sb1", tenant_id: "t1", repo_full_name: TARGET.github_full_name, default_branch: "main" };
  const row = { id: "row1", e2b_sandbox_id: "sb1", preview_status: "live", preview_url: "https://3000-sb1.e2b.app", preview_port: 3000 };

  it("puts the draft back and leaves the preview alone when checkout works", async () => {
    const clearPreview = vi.fn();
    const checkout = vi.fn().mockResolvedValue({ ok: true, sha: SHA_R2 });
    await restoreDraftAfterReset(input, { enabled: async () => true, checkout, loadPreviewRow: async () => row, clearPreview });
    expect(checkout).toHaveBeenCalledWith("sb1", "main");
    expect(clearPreview).not.toHaveBeenCalled();
  });

  it("takes the preview down when the draft could not be put back, so it never shows main as the draft", async () => {
    const clearPreview = vi.fn().mockResolvedValue(undefined);
    await restoreDraftAfterReset(input, {
      enabled: async () => true,
      checkout: vi.fn().mockResolvedValue({ ok: false, reason: "fetch" }),
      loadPreviewRow: async () => row,
      clearPreview,
    });
    expect(clearPreview).toHaveBeenCalledWith("row1");

    const clear2 = vi.fn().mockResolvedValue(undefined);
    await restoreDraftAfterReset(input, {
      enabled: async () => true,
      checkout: vi.fn().mockRejectedValue(new Error("sandbox gone")),
      loadPreviewRow: async () => row,
      clearPreview: clear2,
    });
    expect(clear2).toHaveBeenCalledWith("row1");
  });

  it("does nothing when live edit is off", async () => {
    const checkout = vi.fn();
    await restoreDraftAfterReset(input, { enabled: async () => false, checkout, loadPreviewRow: async () => row, clearPreview: vi.fn() });
    expect(checkout).not.toHaveBeenCalled();
  });
});
